// Boundary-schema tests for the DCS JSON casts converted to parseJson (#484).
//
// These are the guard the issue asks for: a wrong-shaped or truncated DCS
// response must be REJECTED at the boundary (so isViewerOrgMember denies, and
// fileCommitSha / dcsFileMeta fall back to null) rather than flowing inward as
// garbage. No network — parseJson is fed constructed Response objects. Pure
// zod + httpJson, so it runs under `node --experimental-strip-types` without
// loading the Worker runtime that auth.ts / dcsSources.ts pull in.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/dcsSchemas.test.mjs

import assert from "node:assert/strict";
import { parseJson, ResponseSchemaError } from "./httpJson.ts";
import { DcsOrgsResponse, DcsCommitsResponse, DcsContentsMeta } from "./dcsSchemas.ts";
import { fileCommitSha, dcsFileSize } from "./dcsSources.ts";
import { readFileSync } from "node:fs";

// Real responses recorded read-only from git.door43.org (public, no auth) on
// 2026-10-09, trimmed: orgs.json = GET /api/v1/orgs?limit=3 (same
// Organization element type as /user/orgs and /users/{u}/orgs, which need a
// token); commits.json = first 2 of GET /repos/unfoldingWord/en_tn/commits
// ?path=tn_OBA.tsv (emails redacted); contents-file.json = GET
// /repos/unfoldingWord/en_tn/contents/tn_OBA.tsv (base64 `content` shortened);
// contents-dir.json = first 2 of the repo-root contents listing.
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../test-fixtures/dcs/${name}`, import.meta.url), "utf8"));

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    process.exitCode = 1;
    console.log(`  FAIL - ${name}\n    ${err?.message ?? err}`);
  }
}

const json = (v, init) => new Response(JSON.stringify(v), init);

// ── DcsOrgsResponse (auth.ts isViewerOrgMember) ──

await t("orgs: a real list parses, extra Gitea fields stripped", async () => {
  const orgs = await parseJson(
    json([
      { id: 1, username: "unfoldingWord", full_name: "unfoldingWord", visibility: "public" },
      { id: 2, username: "BSOJ" },
    ]),
    DcsOrgsResponse,
    "DCS user orgs",
  );
  assert.equal(orgs.length, 2);
  assert.equal(orgs[0].username, "unfoldingWord");
  // Unknown keys don't survive a default zod object.
  assert.equal("visibility" in orgs[0], false);
});

await t("orgs: an entry with no username parses (username is optional)", async () => {
  const orgs = await parseJson(json([{ id: 9 }]), DcsOrgsResponse, "DCS user orgs");
  assert.equal(orgs[0].username, undefined);
});

await t("orgs: a non-array body is REJECTED (Gitea error object, not a list)", async () => {
  await assert.rejects(
    () => parseJson(json({ message: "Not Found" }), DcsOrgsResponse, "DCS user orgs"),
    (err) => err instanceof ResponseSchemaError && err.endpoint === "DCS user orgs",
  );
});

await t("orgs: a non-string username is REJECTED", async () => {
  await assert.rejects(
    () => parseJson(json([{ username: 123 }]), DcsOrgsResponse, "DCS user orgs"),
    (err) => err instanceof ResponseSchemaError,
  );
});

await t("orgs: a non-JSON body (HTML error page) is REJECTED", async () => {
  await assert.rejects(
    () => parseJson(new Response("<html>502</html>"), DcsOrgsResponse, "DCS user orgs"),
    (err) => err instanceof ResponseSchemaError && /valid JSON/.test(err.detail),
  );
});

// ── DcsCommitsResponse (dcsSources.ts fileCommitSha) ──

await t("commits: a real list parses; the head sha is a string", async () => {
  const commits = await parseJson(
    json([{ sha: "abc123", commit: { message: "x" } }, { sha: "def456" }]),
    DcsCommitsResponse,
    "DCS commits",
  );
  assert.equal(commits[0].sha, "abc123");
});

await t("commits: an empty history parses to []", async () => {
  const commits = await parseJson(json([]), DcsCommitsResponse, "DCS commits");
  assert.equal(commits.length, 0);
  assert.equal(commits[0]?.sha ?? null, null); // fileCommitSha's own read
});

await t("commits: a numeric sha is REJECTED (never returned as a watermark)", async () => {
  await assert.rejects(
    () => parseJson(json([{ sha: 123 }]), DcsCommitsResponse, "DCS commits"),
    (err) => err instanceof ResponseSchemaError,
  );
});

// ── DcsContentsMeta (dcsSources.ts dcsFileMeta) ──

await t("contents: real metadata parses (size + sha), extra fields stripped", async () => {
  const meta = await parseJson(
    json({ name: "tn_OBA.tsv", path: "tn_OBA.tsv", size: 5421, sha: "blob0", type: "file" }),
    DcsContentsMeta,
    "DCS contents",
  );
  assert.equal(meta.size, 5421);
  assert.equal(meta.sha, "blob0");
  assert.equal("type" in meta, false);
});

await t("contents: a non-numeric size is REJECTED (bad shrink-guard input)", async () => {
  await assert.rejects(
    () => parseJson(json({ size: "5421", sha: "blob0" }), DcsContentsMeta, "DCS contents"),
    (err) => err instanceof ResponseSchemaError,
  );
});

await t("contents: a non-JSON body is REJECTED", async () => {
  await assert.rejects(
    () => parseJson(new Response("nope"), DcsContentsMeta, "DCS contents"),
    (err) => err instanceof ResponseSchemaError && /valid JSON/.test(err.detail),
  );
});

// ── Recorded real DCS payloads (nullable/extra fields must not be rejected) ──

await t("real: recorded Organization list parses (nulls in unread fields are fine)", async () => {
  const orgs = await parseJson(json(fixture("orgs.json")), DcsOrgsResponse, "DCS orgs");
  assert.equal(orgs.length, 3);
  assert.equal(typeof orgs[0].username, "string");
});

await t("real: recorded commit list parses", async () => {
  const commits = await parseJson(json(fixture("commits.json")), DcsCommitsResponse, "DCS commits");
  assert.match(commits[0].sha, /^[0-9a-f]{40}$/);
});

await t("real: recorded file contents metadata parses", async () => {
  const meta = await parseJson(json(fixture("contents-file.json")), DcsContentsMeta, "DCS contents");
  assert.equal(meta.size, 55196);
  assert.match(meta.sha, /^[0-9a-f]{40}$/);
});

await t("null in a read field parses (treated like absent, never a sign-in/source break)", async () => {
  const orgs = await parseJson(json([{ username: null }]), DcsOrgsResponse, "DCS orgs");
  assert.equal(orgs[0].username, null);
  const commits = await parseJson(json([{ sha: null }]), DcsCommitsResponse, "DCS commits");
  assert.equal(commits[0].sha, null);
  const meta = await parseJson(json({ size: null, sha: null }), DcsContentsMeta, "DCS contents");
  assert.equal(meta.size, null);
});

// ── The real dcsSources.ts call sites, with fetch stubbed ──
//
// These drive fileCommitSha / dcsFileSize themselves, so they prove the
// failure posture end to end: a valid body yields the value, a malformed one
// yields the same null as a 404 / network error (never a garbage watermark),
// and the rejection is logged with the endpoint name.

const env = { DCS_BASE_URL: "https://dcs.test" };
async function withFetch(body, fn) {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const warnings = [];
  globalThis.fetch = async () => (typeof body === "string" ? new Response(body) : json(body));
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    return await fn(warnings);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
}

await t("fileCommitSha: recorded commit list returns the head sha", async () => {
  await withFetch(fixture("commits.json"), async (warnings) => {
    const sha = await fileCommitSha(env, "unfoldingWord", "en_tn", "tn_OBA.tsv");
    assert.equal(sha, fixture("commits.json")[0].sha);
    assert.equal(warnings.length, 0);
  });
});

await t("fileCommitSha: a numeric sha returns null, not a watermark, and is logged", async () => {
  await withFetch([{ sha: 123 }], async (warnings) => {
    const sha = await fileCommitSha(env, "unfoldingWord", "en_tn", "tn_OBA.tsv");
    assert.equal(sha, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /DCS commits/);
  });
});

await t("fileCommitSha: an HTML error page returns null and is logged", async () => {
  await withFetch("<html>502</html>", async (warnings) => {
    assert.equal(await fileCommitSha(env, "o", "r", "p"), null);
    assert.match(warnings[0] ?? "", /valid JSON/);
  });
});

await t("dcsFileSize: recorded file metadata returns the recorded size", async () => {
  await withFetch(fixture("contents-file.json"), async (warnings) => {
    assert.equal(await dcsFileSize(env, "unfoldingWord", "en_tn", "tn_OBA.tsv"), 55196);
    assert.equal(warnings.length, 0);
  });
});

await t("dcsFileSize: a directory listing (array) returns null, as before, and is logged", async () => {
  await withFetch(fixture("contents-dir.json"), async (warnings) => {
    assert.equal(await dcsFileSize(env, "unfoldingWord", "en_tn", ""), null);
    assert.match(warnings[0] ?? "", /DCS contents/);
  });
});

await t("dcsFileSize: a string size returns null and is logged", async () => {
  await withFetch({ size: "55196", sha: "x" }, async (warnings) => {
    assert.equal(await dcsFileSize(env, "o", "r", "p"), null);
    assert.equal(warnings.length, 1);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
