// Regression tests for resolveWorkspaceFresh() — the request-path resolver that
// closes the warm-stale cross-tenant hole (issue #418), hardened per-slug in
// issue #428.
//
// The bug: the registry is primed ONCE per isolate (registryState WeakMap) and
// never expires, so a workspace claimed on a sibling isolate is invisible to an
// already-warm isolate. resolveWorkspace() then answers that unknown slug with
// list[0] — a DIFFERENT tenant's D1 — and index.ts's fetch handler serves it
// with the caller's admin JWT. resolveWorkspaceFresh() re-reads the registry on
// an unknown slug before falling back.
//
// #419 rate-limited that recheck per shared-DB object (per-isolate), which left
// a ≤10s residual: one dead cookie's recheck suppressed the recheck a DIFFERENT
// freshly-claimed slug needed. #428 makes the limit PER-SLUG (so a freshly-
// claimed slug is not suppressed by an unrelated dead cookie), collapses
// concurrent same-slug callers onto one in-flight reprime, and keeps a GLOBAL
// per-window budget so a distinct-slug spray still can't force unbounded reprimes.
//
// Two-isolate model: registryState / the recheck bookkeeping are keyed on the
// shared-DB OBJECT, so two makeD1 wrappers over one node:sqlite DB behave as two
// isolates sharing one physical database (same trick as workspacesRegistry.test.mjs).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/workspaceResolveFresh.test.mjs

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  primeWorkspaces,
  listWorkspaces,
  resolveWorkspace,
  resolveWorkspaceFresh,
  MAX_UNKNOWN_SLUG_RECHECKS_PER_WINDOW,
} from "./workspaces.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const MIGRATION = readFileSync(new URL("../migrations/0058_workspaces_registry.sql", import.meta.url), "utf8");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(MIGRATION);
  return db;
}

// Minimal D1Database surface workspaces.ts uses. `counts.reads` increments on
// every SELECT .all() (i.e. each registry read), so a test can assert a recheck
// did — or did NOT — hit the DB again.
function makeD1(db, counts = { reads: 0 }) {
  function bound(sql, params) {
    return {
      first: async () => db.prepare(sql).get(...params) ?? null,
      all: async () => {
        if (/^\s*select/i.test(sql)) counts.reads++;
        return { results: db.prepare(sql).all(...params) };
      },
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
    _tag: "shared-db",
  };
}

// Like makeD1, but records the MAX number of registry reads in flight at once.
// A read counts as in flight from when readRegistry issues its SELECT .all()
// until that promise settles (deferred one microtask, so two reads issued in the
// same synchronous burst both register before either settles). `track.max > 1`
// means two reprimes read the shared registry concurrently — the race that lets a
// stale or failed read settle last and clobber a good roster.
function makeTrackingD1(db, counts, track) {
  function bound(sql, params) {
    return {
      first: async () => db.prepare(sql).get(...params) ?? null,
      all: () => {
        if (/^\s*select/i.test(sql)) {
          counts.reads++;
          track.inflight++;
          track.max = Math.max(track.max, track.inflight);
          const results = db.prepare(sql).all(...params);
          return Promise.resolve().then(() => {
            track.inflight--;
            return { results };
          });
        }
        return Promise.resolve({ results: db.prepare(sql).all(...params) });
      },
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
    _tag: "shared-db",
  };
}

// A deployed-but-unclaimed pool binding: live D1-shaped (prepare is a function)
// so parseEntry accepts a claimed row bound to it, but never actually queried.
const liveBinding = () => ({ prepare: () => ({}) });

function claim(db, slug, org, binding) {
  db.prepare(
    "INSERT INTO workspaces (slug, label, org, binding, status) VALUES (?,?,?,?, 'claimed')",
  ).run(slug, org, org, binding);
}

// ── 1. warm isolate resolves a slug claimed AFTER it primed (the fix) ────────

console.log("[resolveFresh] unknown slug claimed on a sibling isolate resolves to ITS binding, not list[0]");
{
  const sqlite = freshDb();
  claim(sqlite, "home", "HomeOrg", "DB"); // the default/first tenant == list[0]

  const counts = { reads: 0 };
  // Isolate B: a deployed pool binding DB_ORGX exists on env, but org X is not
  // yet in B's cached roster.
  const envB = { DB: makeD1(sqlite, counts), DB_ORGX: liveBinding() };

  await primeWorkspaces(envB);
  assert(listWorkspaces(envB).length === 1, "isolate B primed with only the home workspace");
  assert(counts.reads === 1, "one registry read on prime");

  // A claim lands on ANOTHER isolate (its claimWorkspace wrote this row to the
  // shared DB). B's per-isolate cache is unaware of it.
  claim(sqlite, "orgx", "OrgX", "DB_ORGX");

  // Control: the stale synchronous resolver still serves list[0] — the bug.
  const stale = resolveWorkspace(envB, "orgx");
  assert(stale.slug === "home", "resolveWorkspace (stale) hands back list[0]='home' for the unknown slug (the #418 bug)");

  // Fix: resolveWorkspaceFresh rechecks the registry and finds org X.
  const fresh = await resolveWorkspaceFresh(envB, "orgx");
  assert(fresh.slug === "orgx", "resolveWorkspaceFresh resolves the freshly-claimed slug");
  assert(fresh.binding === "DB_ORGX", "…to OrgX's own binding, NOT the home tenant's DB");
  assert(counts.reads === 2, "exactly one extra registry read for the recheck");
}

// ── 2. #428 residual: a freshly-claimed slug arriving WITHIN the window after ─
//       an unrelated dead-cookie recheck still resolves to its OWN binding.
//       Under the #419 per-isolate limit this fell through to list[0].

console.log("[resolveFresh] a freshly-claimed slug within the window (after a dead-cookie recheck) resolves to its own binding");
{
  const sqlite = freshDb();
  claim(sqlite, "home", "HomeOrg", "DB");
  const counts = { reads: 0 };
  const envB = { DB: makeD1(sqlite, counts), DB_ORGX: liveBinding() };

  await primeWorkspaces(envB); // reads == 1

  // t=0: a genuinely-dead cookie triggers the first recheck (finds nothing) and,
  // under the old design, would stamp the shared-DB window for ~10s.
  const dead = await resolveWorkspaceFresh(envB, "dead-cookie");
  assert(dead.slug === "home", "dead cookie falls back to list[0]");
  assert(counts.reads === 2, "the dead cookie triggered one recheck read");

  // t≈3s (within the same window): org X was claimed on a sibling isolate.
  claim(sqlite, "orgx", "OrgX", "DB_ORGX");
  const fresh = await resolveWorkspaceFresh(envB, "orgx");
  assert(fresh.slug === "orgx", "the in-window freshly-claimed slug resolves to ITS binding (residual #428 closed)");
  assert(fresh.binding === "DB_ORGX", "…not the home tenant's DB (the ≤10s cross-tenant window)");
  assert(counts.reads === 3, "the freshly-claimed slug got its OWN recheck despite the earlier dead-cookie window");
}

// ── 3. per-slug idempotency: the SAME dead slug repeated within the window ────
//       rechecks only once (a repeatedly-arriving dead cookie doesn't reprime
//       every request).

console.log("[resolveFresh] the same dead slug repeated within the window rechecks only once");
{
  const sqlite = freshDb();
  claim(sqlite, "home", "HomeOrg", "DB");
  const counts = { reads: 0 };
  const envB = { DB: makeD1(sqlite, counts) };

  await primeWorkspaces(envB); // reads == 1
  const a = await resolveWorkspaceFresh(envB, "dead"); // reads == 2 (one recheck)
  const b = await resolveWorkspaceFresh(envB, "dead"); // same slug in-window: no read
  const c = await resolveWorkspaceFresh(envB, "dead");
  assert(a.slug === "home" && b.slug === "home" && c.slug === "home", "the dead slug always falls back to list[0]");
  assert(counts.reads === 2, "the repeated dead slug in-window rechecked exactly once");
}

// ── 4. DoS bound: a distinct-unknown-slug spray stays within the per-window ───
//       recheck budget, regardless of slug cardinality.

console.log("[resolveFresh] a distinct-slug spray stays within the per-window recheck budget");
{
  const sqlite = freshDb();
  claim(sqlite, "home", "HomeOrg", "DB");
  const counts = { reads: 0 };
  const envB = { DB: makeD1(sqlite, counts) };

  await primeWorkspaces(envB); // reads == 1

  const SPRAY = MAX_UNKNOWN_SLUG_RECHECKS_PER_WINDOW * 5 + 3; // far exceeds the budget
  for (let i = 0; i < SPRAY; i++) {
    const w = await resolveWorkspaceFresh(envB, `ghost-${i}`);
    assert(w.slug === "home", `unresolvable ghost-${i} falls back to list[0]`);
  }
  const rechecks = counts.reads - 1; // subtract the prime read
  assert(
    rechecks === MAX_UNKNOWN_SLUG_RECHECKS_PER_WINDOW,
    `spray of ${SPRAY} distinct slugs triggered exactly the budget (${rechecks} === ${MAX_UNKNOWN_SLUG_RECHECKS_PER_WINDOW}) reprimes, not one per slug`,
  );
}

// ── 5. concurrent callers for the SAME unknown slug collapse to one recheck ───

console.log("[resolveFresh] concurrent callers for the same unknown slug share one in-flight reprime");
{
  const sqlite = freshDb();
  claim(sqlite, "home", "HomeOrg", "DB");
  const counts = { reads: 0 };
  const envB = { DB: makeD1(sqlite, counts), DB_ORGX: liveBinding() };

  await primeWorkspaces(envB); // reads == 1
  claim(sqlite, "orgx", "OrgX", "DB_ORGX");

  // Fire concurrently BEFORE any await settles, so they race the same reprime.
  const [a, b, c] = await Promise.all([
    resolveWorkspaceFresh(envB, "orgx"),
    resolveWorkspaceFresh(envB, "orgx"),
    resolveWorkspaceFresh(envB, "orgx"),
  ]);
  assert(a.slug === "orgx" && b.slug === "orgx" && c.slug === "orgx", "all concurrent callers resolve orgx to its binding");
  assert(a.binding === "DB_ORGX", "…and to OrgX's own DB");
  assert(counts.reads === 2, "the concurrent same-slug callers collapsed to ONE recheck read");
}

// ── 5b. concurrent callers for DIFFERENT unknown slugs never race two registry
//        reads — the reprime-clobber the per-slug limit (#428) otherwise opens.
//        The per-slug relaxation lets two distinct unknown slugs each start their
//        own invalidateAndReprime; primeWorkspaces has no in-flight dedup, so the
//        two reads race and whichever settles LAST wins. A stale or failed read
//        finishing last would clobber a good roster with the fallback, and — both
//        slugs already stamped — a freshly-claimed slug would then fall through to
//        list[0], another tenant's D1, for the window. #419 (per-isolate) never
//        had this (one reprime/window); this asserts reprimes are serialized.

console.log("[resolveFresh] concurrent callers for DIFFERENT unknown slugs never issue two racing registry reads");
{
  const sqlite = freshDb();
  claim(sqlite, "home", "HomeOrg", "DB"); // list[0]
  const counts = { reads: 0 };
  const track = { inflight: 0, max: 0 };
  const envB = { DB: makeTrackingD1(sqlite, counts, track), DB_ORGX: liveBinding() };

  await primeWorkspaces(envB); // reads == 1, one read at a time
  claim(sqlite, "orgx", "OrgX", "DB_ORGX");

  // orgx is genuinely claimed; "dead" is not. Fire both BEFORE any await settles
  // so they race the same registryState. On the pre-fix per-slug resolver both
  // reprimes read concurrently (track.max === 2); serialized, track.max === 1.
  const [a, b] = await Promise.all([
    resolveWorkspaceFresh(envB, "orgx"),
    resolveWorkspaceFresh(envB, "dead"),
  ]);
  assert(a.slug === "orgx" && a.binding === "DB_ORGX", "the freshly-claimed slug still resolves to its OWN binding");
  assert(b.slug === "home", "the dead slug falls back to list[0]");
  assert(track.max === 1, "distinct-slug reprimes are serialized — no two registry reads in flight at once (so a stale/failed read can't clobber a good roster)");
}

// ── 6. known slug / null slug never re-read the registry ────────────────────

console.log("[resolveFresh] a known or null slug resolves from cache with no extra read");
{
  const sqlite = freshDb();
  claim(sqlite, "home", "HomeOrg", "DB");
  claim(sqlite, "orgx", "OrgX", "DB_ORGX");
  const counts = { reads: 0 };
  const envB = { DB: makeD1(sqlite, counts), DB_ORGX: liveBinding() };

  await primeWorkspaces(envB); // reads == 1
  const known = await resolveWorkspaceFresh(envB, "orgx");
  assert(known.slug === "orgx", "known slug resolves");
  const none = await resolveWorkspaceFresh(envB, null);
  assert(none.slug === "home", "null slug -> list[0]");
  assert(counts.reads === 1, "no recheck read for known / null slugs");
}

console.log("workspaceResolveFresh: all assertions passed");
