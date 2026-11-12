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
  CONTEXT_EXPORT_DEFERRED,
  contextExportFailureIsTransient,
  CONTEXT_EXPORT_LEASE_SECONDS,
  SHRINK_OVERRIDE_MAX_AGE_SECONDS,
  contextExportNeedsRun,
  exportContextPackUnderLease,
  queueContextExport,
  runContextExportExclusive,
  requestDailyContextExport,
  sweepContextExportQueue,
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
function harness({ token = "service-token" } = {}) {
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
    ...(token ? { DCS_SERVICE_TOKEN: token } : {}),
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
  // the render and before the commit, to hold a run mid-flight. `outcome`
  // (optional) is returned instead of committing, like renderAndCommitContextPack
  // returning a failed result.
  async function runInstance(id, { params = created.find((c) => c.id === id)?.params ?? {}, gate, shrinkOverride = false, outcome } = {}) {
    const seenOverride = [];
    const result = await runContextExportExclusive({
      db,
      key: "ws",
      instance: id,
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
          if (outcome) return outcome;
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
  return { env, db, sqlite, door43, created, save, runInstance, lock, stats: () => ({ maxRunning }) };
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

// ── PR #737 review ──────────────────────────────────────────────────────────

test("a run that RETURNS a passing failure (Door43 5xx, CAS retries used up, en fetch) keeps the save pending and its retry exports", async () => {
  for (const failureReason of [
    "dcs_batch_commit_failed: POST 500 internal error",
    "cas_retries_exhausted",
    "context_cas_conflict:ref_lock:dcs_batch_commit_failed: POST 403 cannot lock ref",
    "en_fetch_failed:tn:TIT",
    "dcs_batch_commit_failed: POST 422 sha does not match",
  ]) {
    const h = harness();
    await withFetch(h.door43.fetch, async () => {
      await h.save("A");
      const id = h.created[0].id;
      await assert.rejects(h.runInstance(id, { outcome: { status: "failed", failureReason } }), /^Error: context_export_retry:/, failureReason);
      assert.equal(h.lock().holder, null, failureReason);
      assert.equal(h.lock().pending, 1, `${failureReason}: the save is still waiting`);
      assert.equal(await contextExportNeedsRun(h.db, "ws"), true, "the cron sweep would start a run");
      const retry = await h.runInstance(id);
      assert.equal(retry.result.status, "success", failureReason);
      assert.equal(h.door43.state.files.get("brief.md"), "A");
      assert.equal(h.lock().pending, 0);
    });
  }
});

test("a run that RETURNS a failure retrying cannot fix clears the save like a success", async () => {
  for (const outcome of [
    { status: "failed", failureReason: "not_a_gl_project" },
    { status: "failed", failureReason: "context_repo_not_provisioned" },
    { status: "failed", failureReason: "missing_en_source:tn:TIT 1:1" },
    { status: "failed", failureReason: "dcs_batch_commit_failed: POST 403 user does not have write access" },
    { status: "shrink_refused", failureReason: "terms_shrink" },
    { status: "no_content", failureReason: "scaffold_only" },
  ]) {
    const h = harness();
    await withFetch(h.door43.fetch, async () => {
      await h.save("A");
      const r = await h.runInstance(h.created[0].id, { outcome });
      assert.deepEqual(r.result, outcome);
      assert.equal(h.lock().holder, null);
      assert.equal(h.lock().pending, 0, outcome.failureReason);
      assert.equal(await contextExportNeedsRun(h.db, "ws"), false);
    });
  }
});

test("a step retry takes the lease over from its own instance's earlier attempt, which then cannot commit", async () => {
  const h = harness();
  await withFetch(h.door43.fetch, async () => {
    await h.save("A");
    const id = h.created[0].id;
    const hold = deferred();
    const timedOut = h.runInstance(id, { gate: hold.promise }); // the attempt Workflows gave up on
    await new Promise((r) => setImmediate(r));
    await h.save("B");
    const retry = await h.runInstance(id); // the retry, while the old attempt still runs
    assert.equal(retry.result.status, "success");
    assert.equal(h.door43.state.files.get("brief.md"), "B");
    hold.resolve();
    const late = await timedOut;
    assert.equal(late.result.failureReason, "context_export_lease_lost");
    assert.equal(h.door43.state.files.get("brief.md"), "B");
    assert.equal(h.door43.state.posts, 1);
  });
});

test("a waiting shrink override expires: a follow-up that starts more than an hour after the click ignores it", async () => {
  const h = harness();
  const t0 = Date.parse("2026-11-02T12:00:00Z");
  mock.timers.enable({ apis: ["Date"], now: t0 });
  try {
    await withFetch(h.door43.fetch, async () => {
      await h.save("A");
      const hold = deferred();
      const first = h.runInstance(h.created[0].id, { gate: hold.promise });
      await new Promise((r) => setImmediate(r));
      assert.equal((await h.runInstance("context-manual", { shrinkOverride: true })).result, null);
      mock.timers.setTime(t0 + (SHRINK_OVERRIDE_MAX_AGE_SECONDS + 1) * 1000);
      hold.resolve();
      await first;
      const b = await h.runInstance(h.created[1].id);
      assert.deepEqual(b.seenOverride, [false], "the stale override is dropped");
      assert.equal(h.lock().shrink_override_at, null);
    });
  } finally {
    mock.timers.reset();
  }
});

test("the cron sweep finds saves with no live run, and leaves a live run alone", async () => {
  const h = harness();
  const t0 = Date.parse("2026-11-02T12:00:00Z");
  mock.timers.enable({ apis: ["Date"], now: t0 });
  try {
    await withFetch(h.door43.fetch, async () => {
      assert.equal(await contextExportNeedsRun(h.db, "ws"), false, "no row yet");
      await h.save("A");
      assert.equal(await contextExportNeedsRun(h.db, "ws"), true, "pending, not started");
      const hold = deferred();
      const run = h.runInstance(h.created[0].id, { gate: hold.promise });
      await new Promise((r) => setImmediate(r));
      await h.save("B");
      assert.equal(await contextExportNeedsRun(h.db, "ws"), false, "a live run will follow up");
      mock.timers.setTime(t0 + (CONTEXT_EXPORT_LEASE_SECONDS + 1) * 1000);
      assert.equal(await contextExportNeedsRun(h.db, "ws"), true, "the run's lease ran out");
      hold.resolve();
      await run;
    });
  } finally {
    mock.timers.reset();
  }
});

test("exportContextPackUnderLease: dry runs bypass the lease; queued runs need a pending save; manual runs record their own; a held lease defers", async () => {
  const h = harness();
  const calls = [];
  const render = (label) => async (so, holdsLease) => {
    calls.push({ label, so, holds: await holdsLease() });
    return { status: "success", failureReason: null };
  };
  const call = (instanceId, extra, label) =>
    exportContextPackUnderLease({ env: h.env, instanceId, queued: false, dcsAllowed: true, shrinkOverride: false, render: render(label), ...extra });

  assert.deepEqual(await call("dry-1", { dcsAllowed: false }, "dry"), { status: "success", failureReason: null });
  assert.equal(h.lock(), undefined, "a dry run never touches the lock");

  assert.deepEqual(await call("queued-1", { queued: true }, "queued-nothing-pending"), CONTEXT_EXPORT_DEFERRED);
  assert.equal(h.created.length, 0);

  assert.equal((await call("manual-1", {}, "manual")).status, "success");
  assert.equal(h.lock().holder, null);
  assert.equal(h.lock().pending, 0);

  // Another instance holds the lease; a nightly run defers and its request
  // becomes that holder's follow-up.
  const hold = deferred();
  const holderRun = exportContextPackUnderLease({
    env: h.env,
    instanceId: "context-save-ws-x",
    queued: false,
    dcsAllowed: true,
    shrinkOverride: false,
    render: async () => {
      assert.match(h.lock().holder, /^context-save-ws-x#[0-9a-f]{8}$/, "holder = instance id + attempt nonce");
      await hold.promise;
      return { status: "success", failureReason: null };
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await call("nightly-ws-2026-11-02", {}, "nightly"), CONTEXT_EXPORT_DEFERRED);
  hold.resolve();
  await holderRun;
  assert.equal(h.created.length, 1, "one follow-up for the deferred nightly request");
  assert.equal(h.created[0].params.queued, true);
  assert.equal(h.created[0].params.contextOnly, true);
  assert.deepEqual(calls.map((c) => c.label), ["dry", "manual"]);
  assert.ok(calls.every((c) => c.holds));
});

// ── Codex review of #737: no service token ──────────────────────────────────
// Without DCS_SERVICE_TOKEN every context export is a dry run that bypasses the
// lease, so nothing would ever clear a pending flag a save set, and the */5
// sweep would start a run every five minutes forever.

test("without a service token a save starts its dry run as before but leaves nothing pending, and the sweep starts nothing", async () => {
  const h = harness({ token: null });
  await h.save("A");
  assert.equal(h.created.length, 1, "the save still starts its (dry) run");
  assert.equal(h.created[0].params.contextOnly, true);
  assert.equal(h.lock(), undefined, "no pending flag is left for a run that never takes the lease");
  const dry = await exportContextPackUnderLease({
    env: h.env, instanceId: h.created[0].id, queued: true, dcsAllowed: false, shrinkOverride: false,
    render: async () => ({ status: "dry_run", failureReason: "no_service_token" }),
  });
  assert.equal(dry.status, "dry_run");
  for (let i = 0; i < 3; i++) await sweepContextExportQueue(h.env);
  assert.equal(h.created.length, 1, "the sweep starts nothing");

  // A row left pending from when a token was configured is skipped too.
  h.sqlite.prepare(`INSERT INTO context_export_lock (workspace, pending) VALUES ('ws', 1)`).run();
  await sweepContextExportQueue(h.env);
  assert.equal(h.created.length, 1);
});

test("with a service token the sweep starts one run for pending saves with no live run, and none otherwise", async () => {
  const h = harness();
  await sweepContextExportQueue(h.env);
  assert.equal(h.created.length, 0, "nothing pending");
  h.sqlite.prepare(`INSERT INTO context_export_lock (workspace, pending) VALUES ('ws', 1)`).run();
  await sweepContextExportQueue(h.env);
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].params.queued, true);
});

test("the daily context export (#793) starts a run even with no save pending, and only one while a run holds the lease", async () => {
  const h = harness();
  await requestDailyContextExport(h.env);
  assert.equal(h.created.length, 1, "no save pending, but the daily tick still exports");
  assert.equal(h.created[0].params.contextOnly, true);
  assert.equal(h.created[0].params.queued, true);
  // A live run holds the lease: the tick marks pending for its follow-up instead of starting a second run.
  h.sqlite.prepare(`UPDATE context_export_lock SET holder = 'x#1', lease_until = unixepoch() + 600, pending = 0`).run();
  await requestDailyContextExport(h.env);
  assert.equal(h.created.length, 1);
  assert.equal(h.sqlite.prepare(`SELECT pending FROM context_export_lock`).get().pending, 1);
});

test("the daily context export does nothing without a service token", async () => {
  const h2 = harness({ token: null });
  await requestDailyContextExport(h2.env);
  assert.equal(h2.created.length, 0);
});

test("an all-oversized examples selection is not retried (#813)", () => {
  assert.equal(contextExportFailureIsTransient({ status: "failed", failureReason: "examples_selection_empty" }), false);
  assert.equal(contextExportFailureIsTransient({ status: "failed", failureReason: "dcs_batch_commit_failed: POST 502" }), true);
});
