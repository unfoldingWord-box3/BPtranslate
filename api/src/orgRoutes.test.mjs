// Unit tests for orgRoutes.ts GET /api/orgs/search — the clean-match org
// verify behind the Setup wizard's org-entry step. Mirrors adminUsers.test.mjs:
// a real Hono app, real requireAuth/requireAdmin gating (stamped via a tiny
// pre-middleware instead of attachAuth so no DB/JWT is needed), and a stubbed
// globalThis.fetch restored in a finally so it never leaks between tests.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/orgRoutes.test.mjs

import { Hono } from "hono";
import { orgRoutes } from "./orgRoutes.ts";
import { lookupOrgRecord, canonicalOrgName } from "./orgCanonical.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const ENV = { DCS_BASE_URL: "https://git.door43.org", DCS_SERVICE_TOKEN: "svc" };

// Build an app that stamps a fixed auth context (mimicking attachAuth) then
// mounts the real orgRoutes (which apply requireAuth + requireAdmin).
function buildApp({ userId, role } = {}) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (userId !== undefined) c.set("userId", userId);
    if (role !== undefined) c.set("role", role);
    await next();
  });
  app.route("/api/orgs", orgRoutes);
  return app;
}

// A DCS org-lookup stub: GET /api/v1/orgs/{org} returns 200 with the canonical
// record for any org whose lowercase name is in `known`, else 404.
function stubOrgs(known) {
  globalThis.fetch = async (url) => {
    const m = /\/api\/v1\/orgs\/([^/?]+)/.exec(String(url));
    const name = m ? decodeURIComponent(m[1]).toLowerCase() : "";
    const rec = known[name];
    if (!rec) {
      return new Response(JSON.stringify({ message: "GetOrgByName" }), { status: 404 });
    }
    return new Response(JSON.stringify(rec), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const realFetch = globalThis.fetch;

// ── Auth gating ─────────────────────────────────────────────────────────────
console.log("[auth] GET /api/orgs/search requires an authenticated admin");
{
  stubOrgs({});
  try {
    assert(
      (await buildApp().request("/api/orgs/search?q=unfoldingWord", {}, ENV)).status === 401,
      "no auth → 401",
    );
    assert(
      (await buildApp({ userId: 2, role: "editor" }).request("/api/orgs/search?q=x", {}, ENV))
        .status === 403,
      "editor → 403",
    );
    assert(
      (await buildApp({ userId: 1, role: "admin" }).request("/api/orgs/search?q=x", {}, ENV))
        .status === 200,
      "admin → 200",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── Clean match ─────────────────────────────────────────────────────────────
console.log("[clean match] exact canonical verify returns a single match + canonical");
{
  stubOrgs({ unfoldingword: { username: "unfoldingWord", full_name: "unfoldingWord®" } });
  try {
    const app = buildApp({ userId: 1, role: "admin" });
    // typed lowercase resolves to canonical casing
    const res = await app.request("/api/orgs/search?q=unfoldingword", {}, ENV);
    assert(res.status === 200, "200");
    const body = await res.json();
    assert(body.canonical === "unfoldingWord", "canonical is DCS casing");
    assert(Array.isArray(body.matches) && body.matches.length === 1, "one match");
    assert(body.matches[0].org === "unfoldingWord", "match org canonical");
    assert(body.matches[0].fullName === "unfoldingWord®", "match fullName from DCS");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── Not found ───────────────────────────────────────────────────────────────
console.log("[not found] a query that resolves to nothing returns empty matches, no canonical");
{
  stubOrgs({ unfoldingword: { username: "unfoldingWord" } });
  try {
    const app = buildApp({ userId: 1, role: "admin" });
    const res = await app.request("/api/orgs/search?q=NoSuchOrg", {}, ENV);
    assert(res.status === 200, "200");
    const body = await res.json();
    assert(Array.isArray(body.matches) && body.matches.length === 0, "no matches");
    assert(body.canonical === undefined, "no canonical");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── Empty / invalid query (ambiguous-or-empty path) ─────────────────────────
console.log("[empty/invalid] blank or non-ident query returns empty matches without hitting DCS");
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };
  try {
    const app = buildApp({ userId: 1, role: "admin" });
    const empty = await app.request("/api/orgs/search?q=", {}, ENV);
    assert(empty.status === 200 && (await empty.json()).matches.length === 0, "blank q → empty");
    const bad = await app.request("/api/orgs/search?q=bad%20org!", {}, ENV);
    assert(bad.status === 200 && (await bad.json()).matches.length === 0, "non-ident q → empty");
    assert(calls === 0, "no DCS lookup for blank/invalid queries");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── verify-source: parse a pasted URL, verify org + repo exist ───────────────
// A DCS stub for verify-source: answers GET /api/v1/repos/{owner}/{repo} ONLY
// (verify-source no longer calls /api/v1/orgs/*). `repos` maps a lowercased
// "owner/repo" key → a repo record; `transient` maps the same key → an HTTP
// status (429/5xx) to simulate a DCS blip; a `throw` value simulates a network
// error. Any org-endpoint hit fails the test loudly (it must never be called).
function stubRepos(repos, transient = {}) {
  globalThis.fetch = async (url) => {
    const s = String(url);
    if (/\/api\/v1\/orgs\//.test(s)) {
      throw new Error("verify-source must not call the org endpoint");
    }
    const repoM = /\/api\/v1\/repos\/([^/]+)\/([^/?]+)/.exec(s);
    if (repoM) {
      const key = `${decodeURIComponent(repoM[1]).toLowerCase()}/${decodeURIComponent(repoM[2]).toLowerCase()}`;
      const t = transient[key];
      if (t === "throw") throw new Error("network down");
      if (typeof t === "number") return new Response("upstream", { status: t });
      const rec = repos[key];
      if (!rec) return new Response(JSON.stringify({ message: "GetRepo" }), { status: 404 });
      return new Response(JSON.stringify(rec), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
}

console.log("[verify-source] admin gating");
{
  stubRepos({});
  try {
    assert(
      (await buildApp().request("/api/orgs/verify-source?url=BibleAquifer/ar_tn", {}, ENV)).status === 401,
      "no auth → 401",
    );
    assert(
      (await buildApp({ userId: 2, role: "editor" }).request("/api/orgs/verify-source?url=BibleAquifer/ar_tn", {}, ENV)).status === 403,
      "editor → 403",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[verify-source] valid pasted URL resolves org + repo (canonical casing from full_name)");
{
  stubRepos({ "bibleaquifer/ar_tn": { name: "ar_tn", full_name: "BibleAquifer/ar_tn" } });
  try {
    const app = buildApp({ userId: 1, role: "admin" });
    const res = await app.request(
      "/api/orgs/verify-source?url=" + encodeURIComponent("https://git.door43.org/bibleaquifer/ar_tn"),
      {},
      ENV,
    );
    assert(res.status === 200, "200");
    const body = await res.json();
    assert(body.ok === true, "ok:true");
    assert(body.org === "BibleAquifer", "org canonical casing derived from full_name");
    assert(body.repo === "ar_tn", "repo canonical casing derived from full_name");
    assert(body.fullName === "BibleAquifer/ar_tn", "fullName from DCS repo record");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[verify-source] a USER-owned namespace resolves (no org lookup)");
{
  // The owner is a Gitea USER, not an org — GET /api/v1/orgs/{user} would 404.
  // verify-source must still resolve it via the repo endpoint alone.
  stubRepos({ "johndoe/ar_tn": { name: "ar_tn", full_name: "JohnDoe/ar_tn" } });
  try {
    const app = buildApp({ userId: 1, role: "admin" });
    const res = await app.request("/api/orgs/verify-source?url=JohnDoe/ar_tn", {}, ENV);
    const body = await res.json();
    assert(res.status === 200 && body.ok === true, "user-owned repo resolves");
    assert(body.org === "JohnDoe" && body.repo === "ar_tn", "canonical user/repo from full_name");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[verify-source] a DIFFERENT-org URL resolves to that org");
{
  stubRepos({ "someorg/xx_tw": { name: "xx_tw", full_name: "SomeOrg/xx_tw" } });
  try {
    const app = buildApp({ userId: 1, role: "admin" });
    const res = await app.request("/api/orgs/verify-source?url=SomeOrg/xx_tw", {}, ENV);
    const body = await res.json();
    assert(res.status === 200 && body.ok === true && body.org === "SomeOrg" && body.repo === "xx_tw", "different org+repo resolves");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[verify-source] garbage URL → 400; missing param → 400; nonexistent repo → 404");
{
  stubRepos({ "bibleaquifer/ar_tn": { name: "ar_tn", full_name: "BibleAquifer/ar_tn" } });
  try {
    const app = buildApp({ userId: 1, role: "admin" });

    const garbage = await app.request("/api/orgs/verify-source?url=" + encodeURIComponent("https://github.com/x/y"), {}, ENV);
    assert(garbage.status === 400, "non-Door43 host → 400");
    assert((await garbage.json()).error === "unsupported_host", "  ...error is unsupported_host");

    const empty = await app.request("/api/orgs/verify-source", {}, ENV);
    assert(empty.status === 400 && (await empty.json()).error === "empty_url", "missing url param → 400 empty_url");

    const noRepo = await app.request("/api/orgs/verify-source?url=BibleAquifer/no_such_repo", {}, ENV);
    assert(noRepo.status === 404 && (await noRepo.json()).error === "repo_not_found", "genuine 404 → 404 repo_not_found");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[verify-source] transient DCS failure → 503 dcs_unavailable (NOT a false 404)");
{
  // A real, existing repo, but DCS is throwing 5xx / rate-limiting / offline.
  try {
    for (const t of [500, 502, 429, "throw"]) {
      stubRepos({ "bibleaquifer/ar_tn": { name: "ar_tn", full_name: "BibleAquifer/ar_tn" } }, { "bibleaquifer/ar_tn": t });
      const app = buildApp({ userId: 1, role: "admin" });
      const res = await app.request("/api/orgs/verify-source?url=BibleAquifer/ar_tn", {}, ENV);
      assert(res.status === 503, `transient ${t} → 503 (not 404)`);
      assert((await res.json()).error === "dcs_unavailable", `  ...error is dcs_unavailable for ${t}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── verify-source content check (checkBooks): a scripture lane source must
// actually contain USFM book files, not just exist. ─────────────────────────
// This stub answers the repo endpoint AND the contents endpoint. `contents`
// maps "owner/repo" → an array of contents entries; `contentsStatus` maps the
// same key → a non-200 status to simulate a transient contents-API failure.
function stubReposAndContents(repos, contents = {}, contentsStatus = {}) {
  globalThis.fetch = async (url) => {
    const s = String(url);
    const contentsM = /\/api\/v1\/repos\/([^/]+)\/([^/]+)\/contents/.exec(s);
    if (contentsM) {
      const key = `${decodeURIComponent(contentsM[1]).toLowerCase()}/${decodeURIComponent(contentsM[2]).toLowerCase()}`;
      const st = contentsStatus[key];
      if (typeof st === "number") return new Response("upstream", { status: st });
      const entries = contents[key] ?? [];
      return new Response(JSON.stringify(entries), { status: 200, headers: { "content-type": "application/json" } });
    }
    const repoM = /\/api\/v1\/repos\/([^/]+)\/([^/?]+)/.exec(s);
    if (repoM) {
      const key = `${decodeURIComponent(repoM[1]).toLowerCase()}/${decodeURIComponent(repoM[2]).toLowerCase()}`;
      const rec = repos[key];
      if (!rec) return new Response(JSON.stringify({ message: "GetRepo" }), { status: 404 });
      return new Response(JSON.stringify(rec), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
}

console.log("[verify-source] checkBooks flags a scaffolding-only repo as hasBooks:false");
{
  stubReposAndContents(
    { "bibleeditormltest/en_glt": { name: "en_glt", full_name: "BibleEditorMLTest/en_glt" } },
    {
      // Only scaffolding — no USFM book files.
      "bibleeditormltest/en_glt": [
        { type: "file", name: ".gitignore" },
        { type: "file", name: "LICENSE.md" },
        { type: "file", name: "README.md" },
        { type: "file", name: "manifest.yaml" },
      ],
    },
  );
  try {
    const app = buildApp({ userId: 1, role: "admin" });
    const res = await app.request("/api/orgs/verify-source?checkBooks=1&url=BibleEditorMLTest/en_glt", {}, ENV);
    const body = await res.json();
    assert(res.status === 200 && body.ok === true, "repo exists → ok");
    assert(body.hasBooks === false, "scaffolding-only → hasBooks:false");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[verify-source] checkBooks reports hasBooks:true when USFM files are present");
{
  stubReposAndContents(
    { "unfoldingword/en_ult": { name: "en_ult", full_name: "unfoldingWord/en_ult" } },
    {
      "unfoldingword/en_ult": [
        { type: "file", name: "LICENSE.md" },
        { type: "file", name: "01-GEN.usfm" },
        { type: "file", name: "02-EXO.usfm" },
      ],
    },
  );
  try {
    const app = buildApp({ userId: 1, role: "admin" });
    const res = await app.request("/api/orgs/verify-source?checkBooks=1&url=unfoldingWord/en_ult", {}, ENV);
    const body = await res.json();
    assert(res.status === 200 && body.ok === true, "ok");
    assert(body.hasBooks === true, "USFM present → hasBooks:true");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[verify-source] a transient contents-API failure OMITS hasBooks (never a false empty)");
{
  stubReposAndContents(
    { "unfoldingword/en_ult": { name: "en_ult", full_name: "unfoldingWord/en_ult" } },
    {},
    { "unfoldingword/en_ult": 502 },
  );
  try {
    const app = buildApp({ userId: 1, role: "admin" });
    const res = await app.request("/api/orgs/verify-source?checkBooks=1&url=unfoldingWord/en_ult", {}, ENV);
    const body = await res.json();
    assert(res.status === 200 && body.ok === true, "repo still verifies ok");
    assert(!("hasBooks" in body), "contents blip → hasBooks omitted (client retries, not a false empty)");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[verify-source] without checkBooks, no content call is made and hasBooks is absent");
{
  stubReposAndContents(
    { "unfoldingword/en_ult": { name: "en_ult", full_name: "unfoldingWord/en_ult" } },
    { "unfoldingword/en_ult": [{ type: "file", name: "01-GEN.usfm" }] },
  );
  try {
    const app = buildApp({ userId: 1, role: "admin" });
    const res = await app.request("/api/orgs/verify-source?url=unfoldingWord/en_ult", {}, ENV);
    const body = await res.json();
    assert(res.status === 200 && body.ok === true && !("hasBooks" in body), "no checkBooks → hasBooks absent");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[lookupOrgRecord] a body carrying only `name` (Door43 deprecates `username`, #581)");
{
  stubOrgs({ neworg: { name: "NewOrg", full_name: "New Org" }, bare: { name: "", username: "Bare" } });
  try {
    const rec = await lookupOrgRecord(ENV, "neworg");
    assert(
      rec && rec.username === "NewOrg" && rec.fullName === "New Org",
      `name-only body → canonical record, got ${JSON.stringify(rec)}`,
    );
    assert((await canonicalOrgName(ENV, "neworg")) === "NewOrg", "canonicalOrgName takes Door43's casing from `name`");
    const bare = await lookupOrgRecord(ENV, "bare");
    assert(bare && bare.username === "Bare", "an empty `name` falls back to `username`");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("orgRoutes search tests passed");
