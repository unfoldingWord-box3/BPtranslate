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

let passed = 0;
async function t(name, fn) {
  await fn();
  passed++;
  console.log(`  ok - ${name}`);
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

console.log(`\n${passed} passed`);
