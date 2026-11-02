// Tests for commitContextPackToMaster (contextExportDcs.ts) against a stubbed
// Door43 API. Run from api/:
//   node --experimental-strip-types --no-warnings --test src/contextExportDcs.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { commitContextPackToMaster } from "./contextExportDcs.ts";

const cfg = { baseUrl: "https://dcs.example", token: "secret", owner: "mltest", repo: "translation-context" };
const files = [{ path: "brief.md", content: "# Brief\n" }];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Fake Door43 for one commit: master starts at `tip`; the contents POST answers
// with `post` (status + text body) or, when omitted, commits `new-sha` on top
// of `tip` and moves master there.
function stubDcs({ tip = "tip-sha", post } = {}) {
  let master = tip;
  return async (url, init = {}) => {
    const u = String(url);
    const method = init.method ?? "GET";
    if (method === "GET" && u.endsWith("/branches/master")) return json({ name: "master", commit: { id: master } });
    if (method === "GET" && u.includes("/git/trees/master")) return json({ tree: [], truncated: false });
    if (method === "POST" && u.endsWith("/contents")) {
      if (post) return new Response(post.body, { status: post.status });
      master = "new-sha";
      return json({ commit: { sha: "new-sha" } }, 201);
    }
    if (method === "GET" && u.endsWith("/git/commits/new-sha")) return json({ sha: "new-sha", parents: [{ sha: tip }] });
    throw new Error(`unexpected fetch ${method} ${u}`);
  };
}

async function withFetch(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("a Door43 'cannot lock ref' refusal becomes a retryable context_cas_conflict", async () => {
  const body = "cannot lock ref 'refs/heads/master': is at aaa but expected bbb";
  await withFetch(stubDcs({ post: { status: 403, body } }), () =>
    assert.rejects(commitContextPackToMaster(cfg, files, "msg", "tip-sha"), (e) => {
      assert.match(e.message, /^context_cas_conflict:ref_lock:/);
      assert.match(e.message, /cannot lock ref/);
      return true;
    }),
  );
});

test("an unrelated 403 (e.g. permissions) stays dcs_batch_commit_failed", async () => {
  await withFetch(stubDcs({ post: { status: 403, body: "user does not have write access" } }), () =>
    assert.rejects(commitContextPackToMaster(cfg, files, "msg", "tip-sha"), /^Error: dcs_batch_commit_failed: POST 403/),
  );
});

test("happy path returns the new commit sha with changed: true", async () => {
  const result = await withFetch(stubDcs(), () => commitContextPackToMaster(cfg, files, "msg", "tip-sha"));
  assert.deepEqual(result, { commitSha: "new-sha", parentSha: "tip-sha", changed: true, committedCount: 1 });
});
