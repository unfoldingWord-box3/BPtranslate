// One context export at a time per workspace (#716, #722), against a stateful
// fake Door43. The real ExportWorkflow can't load under node (cloudflare:workers),
// so these drive the queue functions it calls (contextExportQueue.ts) with a
// stand-in for exportContextPack that renders one file from D1 and commits it
// with the real commitContextPackToMaster. Run from api/:
//   node --experimental-strip-types --no-warnings --test src/contextExportQueue.test.mjs

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTEXT_EXPORT_LEASE_SECONDS,
  queueContextExport,
  runContextExportExclusive,
} from "./contextExportQueue.ts";
import { commitContextPackToMaster, getBranchTipSha } from "./contextExportDcs.ts";
import { gitBlobSha } from "./articleExport.ts";

function makeDb(sqlite) {
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    async all() {
      return { results: sqlite.prepare(sql).all(...args), success: true };
    },
    async first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    async run() {
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return { prepare: (sql) => mk(sql, []) };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Door43 with real state: master's commit, its files, each commit's parent.
// Like Gitea's ChangeFiles, the POST checks each file's sha and nothing else
// (no base commit), so a stale run whose tree read saw the newer commit lands
// on top of it — the #722 F3 race.
function fakeDoor43() {
  const state = { master: "c0", files: new Map(), parents: new Map([["c0", null]]), posts: 0, inFlight: 0, maxInFlight: 0 };
  let n = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    if (method === "GET" && u.pathname.endsWith("/branches/master")) return json({ name: "master", commit: { id: state.master } });
    if (method === "GET" && u.pathname.endsWith("/git/trees/master")) {
      if (u.searchParams.get("page") !== "1") return json({ tree: [], truncated: false });
      const tree = [];
      for (const [path, content] of state.files) tree.push({ path, type: "blob", sha: await gitBlobSha(content) });
      return json({ tree, truncated: false });
    }
    if (method === "POST" && u.pathname.endsWith("/contents")) {
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        await new Promise((r) => setImmediate(r));
        const body = JSON.parse(init.body);
        for (const f of body.files) {
          const cur = state.files.get(f.path);
          if (f.operation !== "create" && (cur == null || (await gitBlobSha(cur)) !== f.sha)) {
            return new Response(`sha does not match [given: ${f.sha}]`, { status: 422 });
          }
        }
        for (const f of body.files) {
          if (f.operation === "delete") state.files.delete(f.path);
          else state.files.set(f.path, Buffer.from(f.content, "base64").toString("utf8"));
        }
        const sha = `c${++n}`;
        state.parents.set(sha, state.master);
        state.master = sha;
        state.posts++;
        return json({ commit: { sha } }, 201);
      } finally {
        state.inFlight--;
      }
    }
    const commit = u.pathname.match(/\/git\/commits\/(c\d+)$/);
    if (method === "GET" && commit) return json({ sha: commit[1], parents: [{ sha: state.parents.get(commit[1]) }] });
    throw new Error(`unexpected fetch ${method} ${u}`);
  };
  return { state, fetch };
}

const dcsCfg = { baseUrl: "https://dcs.example", token: "t", owner: "org", repo: "translation-context" };

// A pausable stand-in for one Workflow engine: records creates (rejecting a
// repeated id, as Cloudflare Workflows does) and runs instances on demand.
function harness() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(join(dir, f), "utf8"));
  sqlite.exec(`CREATE TABLE test_pack (id INTEGER PRIMARY KEY, body TEXT)`);
  sqlite.prepare(`INSERT INTO test_pack (id, body) VALUES (1, 'v0')`).run();
  const db = makeDb(sqlite);
  const door43 = fakeDoor43();
  const created = [];
  const seen = new Set();
  const env = {
    DB: db,
    WORKSPACE_SLUG: "ws",
    EXPORT_WORKFLOW: {
      async create(opts) {
        if (seen.has(opts.id)) throw new Error(`instance.already_exists: ${opts.id}`);
        seen.add(opts.id);
        created.push(opts);
        return { id: opts.id };
      },
    },
  };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  let running = 0;
  let maxRunning = 0;

  // A save: write D1, then queue the export, as the routes do.
  async function save(body) {
    sqlite.prepare(`UPDATE test_pack SET body = ? WHERE id = 1`).run(body);
    queueContextExport({ env, executionCtx: ctx });
    await Promise.all(pending.splice(0));
  }

  // One Workflow instance's context step. `gate` (optional) is awaited after
  // the render and before the commit, to hold a run mid-flight.
  async function runInstance(id, { params = created.find((c) => c.id === id)?.params ?? {}, gate, shrinkOverride = false } = {}) {
    const seenOverride = [];
    const result = await runContextExportExclusive({
      db,
      key: "ws",
      holder: id,
      markPending: !params.queued,
      shrinkOverride: shrinkOverride || !!params.shrinkOverride,
      startFollowUp: () => env.EXPORT_WORKFLOW.create({ id: `follow-${created.length}`, params: { contextOnly: true, workspace: "ws", queued: true } }),
      run: async ({ shrinkOverride: so, holdsLease }) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        try {
          seenOverride.push(so);
          const body = sqlite.prepare(`SELECT body FROM test_pack WHERE id = 1`).get().body;
          if (gate) await gate;
          if (!(await holdsLease())) return { status: "failed", body, failureReason: "context_export_lease_lost" };
          const tip = await getBranchTipSha(dcsCfg, "master");
          const c = await commitContextPackToMaster(dcsCfg, [{ path: "brief.md", content: body }], `export ${id}`, tip);
          return { status: "success", body, commitSha: c.commitSha };
        } finally {
          running--;
        }
      },
    });
    return { result, seenOverride };
  }

  const lock = () => sqlite.prepare(`SELECT * FROM context_export_lock WHERE workspace = 'ws'`).get();
  return { env, sqlite, door43, created, save, runInstance, lock, stats: () => ({ maxRunning }) };
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

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test("saves during a run coalesce into one follow-up; the follow-up renders at its start and lands the last save", async () => {
  const h = harness();
  await withFetch(h.door43.fetch, async () => {
    await h.save("A");
    assert.equal(h.created.length, 1, "the first save starts one run");
    const hold = deferred();
    const first = h.runInstance(h.created[0].id, { gate: hold.promise });
    await new Promise((r) => setImmediate(r));

    await h.save("B");
    await h.save("C");
    assert.equal(h.created.length, 1, "saves during the run start nothing new");
    assert.equal(h.lock().pending, 1, "they are waiting for the follow-up");

    hold.resolve();
    const a = await first;
    assert.equal(a.result.body, "A", "the first run publishes what it read at its start");
    assert.equal(h.created.length, 2, "exactly one follow-up is queued when the first run ends");
    assert.equal(h.created[1].params.queued, true);

    const b = await h.runInstance(h.created[1].id);
    assert.equal(b.result.status, "success");
    assert.equal(h.door43.state.files.get("brief.md"), "C", "Door43 holds the last save");
    assert.equal(h.created.length, 2, "no further run once nothing is pending");
    assert.equal(h.lock().holder, null);
    assert.equal(h.lock().pending, 0);
    assert.equal(h.stats().maxRunning, 1);
    assert.equal(h.door43.state.maxInFlight, 1);
  });
});

test("a second run started while one is in flight does not export; an older pack never lands over a newer one", async () => {
  const h = harness();
  await withFetch(h.door43.fetch, async () => {
    await h.save("old");
    const hold = deferred();
    const stale = h.runInstance(h.created[0].id, { gate: hold.promise });
    await new Promise((r) => setImmediate(r));

    // A newer save, then a manual or nightly export starting while the first
    // run still holds its render of "old".
    h.sqlite.prepare(`UPDATE test_pack SET body = 'new' WHERE id = 1`).run();
    const manual = await h.runInstance("manual-1");
    assert.equal(manual.result, null, "the manual run waits instead of exporting alongside");
    assert.equal(h.door43.state.posts, 0);

    hold.resolve();
    await stale;
    assert.equal(h.created.length, 2, "the waiting manual run becomes the follow-up");
    await h.runInstance(h.created[1].id);
    assert.equal(h.door43.state.files.get("brief.md"), "new", "the newest save is what Door43 ends with");
    assert.equal(h.stats().maxRunning, 1);
  });
});

test("a run that died holding the lease is taken over once the lease runs out; the dead run can no longer commit", async () => {
  const h = harness();
  const t0 = Date.parse("2026-11-02T12:00:00Z");
  mock.timers.enable({ apis: ["Date"], now: t0 });
  try {
    await withFetch(h.door43.fetch, async () => {
      await h.save("A");
      const hold = deferred(); // never resolved by the "crash" until the end
      const dead = h.runInstance(h.created[0].id, { gate: hold.promise });
      await new Promise((r) => setImmediate(r));

      await h.save("B");
      assert.equal(h.created.length, 1, "a live lease means the save waits");

      mock.timers.setTime(t0 + (CONTEXT_EXPORT_LEASE_SECONDS + 1) * 1000);
      await h.save("C");
      assert.equal(h.created.length, 2, "after the lease runs out the next save starts a run");
      const taken = await h.runInstance(h.created[1].id);
      assert.equal(taken.result.status, "success");
      assert.equal(h.door43.state.files.get("brief.md"), "C");

      // The stuck run wakes up: its claim is gone, so it must not commit "A".
      hold.resolve();
      const late = await dead;
      assert.equal(late.result.failureReason, "context_export_lease_lost");
      assert.equal(h.door43.state.files.get("brief.md"), "C");
      assert.equal(h.door43.state.posts, 1);
    });
  } finally {
    mock.timers.reset();
  }
});

test("two saves in the same second both land, even when the first run finished inside that second", async () => {
  const h = harness();
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-30T12:00:00.250Z") });
  try {
    await withFetch(h.door43.fetch, async () => {
      await h.save("A");
      await h.runInstance(h.created[0].id);
      assert.equal(h.door43.state.files.get("brief.md"), "A");
      await h.save("B");
      assert.equal(h.created.length, 2, "the second save starts its own run");
      assert.notEqual(h.created[0].id, h.created[1].id);
      for (const c of h.created) {
        assert.match(c.id, /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/); // Workflows' instance-id rule
        assert.ok(c.id.length <= 100, c.id);
      }
      await h.runInstance(h.created[1].id);
      assert.equal(h.door43.state.files.get("brief.md"), "B");
    });
  } finally {
    mock.timers.reset();
  }
});

test("a run that throws gives the lease back with the save still pending, so its retry exports", async () => {
  const h = harness();
  await withFetch(h.door43.fetch, async () => {
    await h.save("A");
    const id = h.created[0].id;
    const real = h.door43.fetch;
    globalThis.fetch = async (url, init) => {
      if ((init?.method ?? "GET") === "POST") throw new Error("network down");
      return real(url, init);
    };
    await assert.rejects(h.runInstance(id), /network down/);
    assert.equal(h.lock().holder, null);
    assert.equal(h.lock().pending, 1);
    globalThis.fetch = real;
    const retry = await h.runInstance(id); // the Workflow step's retry
    assert.equal(retry.result.status, "success");
    assert.equal(h.door43.state.files.get("brief.md"), "A");
  });
});

test("an admin's shrink override that had to wait is carried to the follow-up", async () => {
  const h = harness();
  await withFetch(h.door43.fetch, async () => {
    await h.save("A");
    const hold = deferred();
    const first = h.runInstance(h.created[0].id, { gate: hold.promise });
    await new Promise((r) => setImmediate(r));
    const waited = await h.runInstance("context-manual", { shrinkOverride: true });
    assert.equal(waited.result, null);
    hold.resolve();
    const a = await first;
    assert.deepEqual(a.seenOverride, [false]);
    const b = await h.runInstance(h.created[1].id);
    assert.deepEqual(b.seenOverride, [true], "the follow-up runs with the override");
    const c = await h.runInstance("later");
    assert.deepEqual(c.seenOverride, [false], "the override is used once");
  });
});
