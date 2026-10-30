// Run: node --experimental-strip-types --no-warnings --test src/contextExportDcs.test.mjs
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { commitContextPackToMaster } from "./contextExportDcs.ts";

const cfg = { baseUrl: "https://dcs.test", token: "t", owner: "org", repo: "translation-context" };
const files = [{ path: "templates/templates.tsv", content: "a\tb\n" }];
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Master sits at `tip`; the tree read finds an empty repo; the batch commit
// POST answers with `post`.
function stubDcs(tip, post) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if ((init.method ?? "GET") === "POST" && u.endsWith("/contents")) {
      return new Response(JSON.stringify(post.body), { status: post.status });
    }
    if (u.includes("/branches/master")) {
      return new Response(JSON.stringify({ commit: { id: tip } }), { status: 200 });
    }
    if (u.includes("/git/trees/")) return new Response("{}", { status: 404 });
    throw new Error(`unexpected fetch ${init.method ?? "GET"} ${u}`);
  };
}

// #712: a second export moved master between our tip check and the commit.
// Door43 refuses the ref update; that must surface as a CAS conflict so the
// workflow re-renders and retries instead of failing the export.
test("Door43 'cannot lock ref' 403 is reported as a CAS conflict", async () => {
  stubDcs("504b90d", {
    status: 403,
    body: {
      message:
        "cannot lock ref 'refs/heads/master': is at 8cb3a81 but expected 504b90d",
      url: "https://git.door43.org/api/swagger",
    },
  });
  await assert.rejects(
    commitContextPackToMaster(cfg, files, "msg", "504b90d"),
    (e) => {
      assert.match(e.message, /^context_cas_conflict:ref_lock:/);
      assert.match(e.message, /cannot lock ref/);
      return true;
    },
  );
});

test("other commit failures stay dcs_batch_commit_failed", async () => {
  stubDcs("504b90d", { status: 403, body: { message: "user does not have permission" } });
  await assert.rejects(
    commitContextPackToMaster(cfg, files, "msg", "504b90d"),
    /^Error: dcs_batch_commit_failed: POST 403/,
  );
});
