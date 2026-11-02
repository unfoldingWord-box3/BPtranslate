// Unit tests for the spare-pool claim mechanism (issue #81, PR-2) in
// workspaces.ts: registerPoolSlot / claimWorkspace / getPoolStatus.
//
// Real D1 via node:sqlite with the actual 0058 migration applied, so the
// UNIQUE/CHECK constraints and the status lifecycle are exercised for real.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/workspacesPool.test.mjs

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { registerPoolSlot, claimWorkspace, isClaimBlocked, getPoolStatus, listWorkspaces } from "./workspaces.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

async function assertThrows(fn, msg) {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(threw, msg);
}

const MIGRATION = readFileSync(new URL("../migrations/0058_workspaces_registry.sql", import.meta.url), "utf8");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(MIGRATION);
  return db;
}

function makeD1(db) {
  function bound(sql, params) {
    return {
      first: async () => db.prepare(sql).get(...params) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...params) }),
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
  };
}

// A live-but-inert D1 stub for a pool binding (only needs `.prepare` to pass the
// native-binding validity gate).
const liveBinding = () => ({ prepare: () => ({}) });

// env: real registry DB on DB/SHARED_DB, plus two live pool bindings.
function makeEnv(db, extra = {}) {
  const d1 = makeD1(db);
  return { DB: d1, SHARED_DB: d1, DB_POOL1: liveBinding(), DB_POOL2: liveBinding(), DB_POOL3: liveBinding(), ...extra };
}

function rowBySlug(db, slug) {
  return db.prepare("SELECT slug, org, label, binding, export_owner, status FROM workspaces WHERE slug = ?").get(slug);
}

// ── registerPoolSlot ─────────────────────────────────────────────────────────

console.log("[registerPoolSlot] registers a live binding as an 'available' slot");
{
  const db = freshDb();
  const env = makeEnv(db);

  const r1 = await registerPoolSlot(env, { binding: "DB_POOL1" });
  assert(r1.ok && r1.slot?.slug === "pool1", "DB_POOL1 -> slug derived 'pool1'");
  assert(r1.slot?.status === "available", "registered slot is 'available'");
  assert(r1.slot?.org === null && r1.slot?.label === null, "available slot has no org/label yet");
  assert(r1.slot?.bindingLive === true, "registered slot reports bindingLive=true");

  const r2 = await registerPoolSlot(env, { binding: "DB_POOL2", slug: "custom-slug", databaseUuid: "uuid-xyz" });
  assert(r2.ok && r2.slot?.slug === "custom-slug", "explicit slug honored");
  assert(rowBySlug(db, "custom-slug").binding === "DB_POOL2", "binding stored");

  const dead = await registerPoolSlot(env, { binding: "DB_NOT_DECLARED" });
  assert(!dead.ok && dead.error === "binding_not_live", "binding not live on env -> binding_not_live");

  // Same binding under a DIFFERENT slug must be rejected — one binding = one
  // physical DB = one workspace, else two orgs could be claimed onto it. (This
  // check runs before the slug check, so re-registering DB_POOL1 is binding_taken.)
  const dupBinding = await registerPoolSlot(env, { binding: "DB_POOL2", slug: "another-slug" });
  assert(!dupBinding.ok && dupBinding.error === "binding_taken", "binding already registered -> binding_taken");

  // A NEW binding whose slug collides with an existing one -> slug_taken.
  const dupSlug = await registerPoolSlot(env, { binding: "DB_POOL3", slug: "pool1" });
  assert(!dupSlug.ok && dupSlug.error === "slug_taken", "new binding, colliding slug -> slug_taken");

  const empty = await registerPoolSlot(env, { binding: "" });
  assert(!empty.ok && empty.error === "invalid_binding", "empty binding -> invalid_binding");

  const badSlug = await registerPoolSlot(env, { binding: "DB_POOL1", slug: "Bad Slug!" });
  assert(!badSlug.ok && badSlug.error === "invalid_slug", "invalid explicit slug -> invalid_slug");

  // "default" is reserved for the implicit workspace (#502): explicit or derived.
  const reserved = await registerPoolSlot(env, { binding: "DB_POOL3", slug: "default" });
  assert(!reserved.ok && reserved.error === "invalid_slug", "explicit slug 'default' -> invalid_slug");
  const derived = await registerPoolSlot({ ...env, DB_DEFAULT: liveBinding() }, { binding: "DB_DEFAULT" });
  assert(!derived.ok && derived.error === "invalid_slug", "binding DB_DEFAULT (derived slug 'default') -> invalid_slug");
}

// ── claimWorkspace: happy path, ordering, idempotency, exhaustion ───────────

console.log("[claimWorkspace] claims the oldest available slot, is idempotent, exhausts cleanly");
{
  const db = freshDb();
  const env = makeEnv(db);
  await registerPoolSlot(env, { binding: "DB_POOL1" }); // pool1 (id 1)
  await registerPoolSlot(env, { binding: "DB_POOL2" }); // pool2 (id 2)

  const c1 = await claimWorkspace(env, { org: "AlphaOrg", label: "Alpha", exportOwner: "AlphaExport" });
  assert(c1 && !c1.alreadyClaimed, "first claim succeeds, not alreadyClaimed");
  assert(c1.workspace.slug === "pool1", "oldest available slot claimed first");
  assert(c1.workspace.org === "AlphaOrg" && c1.workspace.exportOwner === "AlphaExport", "org + exportOwner stamped on workspace");
  const row1 = rowBySlug(db, "pool1");
  assert(row1.status === "claimed" && row1.org === "AlphaOrg" && row1.label === "Alpha", "row flipped to claimed with org/label");

  // The claim is visible to listWorkspaces in this isolate (cache reprimed).
  assert(listWorkspaces(env).some((w) => w.slug === "pool1" && w.org === "AlphaOrg"), "claimed workspace appears in listWorkspaces");

  const again = await claimWorkspace(env, { org: "AlphaOrg", label: "Alpha Again" });
  assert(again && again.alreadyClaimed && again.workspace.slug === "pool1", "re-claim for same org is idempotent (alreadyClaimed)");
  assert(rowBySlug(db, "pool2").status === "available", "idempotent re-claim did NOT consume a second slot");

  const c2 = await claimWorkspace(env, { org: "BetaOrg", label: "Beta" });
  assert(c2 && !c2.alreadyClaimed && c2.workspace.slug === "pool2", "different org claims the next slot");

  const exhausted = await claimWorkspace(env, { org: "GammaOrg", label: "Gamma" });
  assert(exhausted === null, "no available slots left -> null (pool exhausted)");
}

// ── claimWorkspace: skips slots whose binding isn't a live D1 ───────────────

console.log("[claimWorkspace] skips available slots whose binding isn't deployed");
{
  const db = freshDb();
  const env = makeEnv(db);
  // A slot declared for a binding that isn't live on this deployment (inserted
  // directly — registerPoolSlot would reject it). Then a genuinely live slot.
  db.prepare("INSERT INTO workspaces (slug, binding, status) VALUES ('ghost', 'DB_GONE', 'available')").run();
  await registerPoolSlot(env, { binding: "DB_POOL1" });

  const claim = await claimWorkspace(env, { org: "RealOrg", label: "Real" });
  assert(claim && claim.workspace.slug === "pool1", "dead-binding slot skipped, live slot claimed");
  assert(rowBySlug(db, "ghost").status === "available", "dead-binding slot left untouched");
}

console.log("[claimWorkspace] never claims a new org into an available slot named 'default' (#502)");
{
  const db = freshDb();
  const env = makeEnv(db);
  // Inserted directly (registerPoolSlot refuses the slug), ahead of a normal slot.
  db.prepare("INSERT INTO workspaces (slug, binding, status) VALUES ('default', 'DB_POOL2', 'available')").run();
  await registerPoolSlot(env, { binding: "DB_POOL1" });

  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(" "));
  let claim;
  try {
    claim = await claimWorkspace(env, { org: "RealOrg", label: "Real" });
  } finally {
    console.warn = realWarn;
  }
  assert(claim && claim.workspace.slug === "pool1", "reserved 'default' slot skipped, next slot claimed");
  assert(rowBySlug(db, "default").status === "available", "reserved slot left untouched");
  assert(warnings.some((w) => w.includes('reserved slug "default"')), "skip logs a warning naming the reserved slug");
}

// ── claimWorkspace: never assigns two orgs to the same physical DB ──────────

console.log("[claimWorkspace] skips an available slot whose binding is already claimed");
{
  const db = freshDb();
  const env = makeEnv(db);
  // OrgA already holds DB_POOL1. A stray available row ALSO points at DB_POOL1
  // (inserted directly — registerPoolSlot would reject it). A live DB_POOL2 too.
  db.prepare("INSERT INTO workspaces (slug, label, org, binding, status) VALUES ('a', 'A', 'OrgA', 'DB_POOL1', 'claimed')").run();
  db.prepare("INSERT INTO workspaces (slug, binding, status) VALUES ('dup1', 'DB_POOL1', 'available')").run();
  db.prepare("INSERT INTO workspaces (slug, binding, status) VALUES ('slot2', 'DB_POOL2', 'available')").run();

  const claim = await claimWorkspace(env, { org: "OrgB", label: "B" });
  assert(claim && claim.workspace.binding === "DB_POOL2", "in-use binding skipped; claim lands on the free DB_POOL2");
  assert(rowBySlug(db, "dup1").status === "available", "the duplicate-binding slot was left unclaimed");
}

// ── claimWorkspace: pre-existing claimed row for org is returned as-is ───────

console.log("[claimWorkspace] pre-existing claimed row for the org short-circuits");
{
  const db = freshDb();
  const env = makeEnv(db);
  db.prepare("INSERT INTO workspaces (slug, label, org, binding, status) VALUES ('existing', 'Existing', 'DupOrg', 'DB_POOL1', 'claimed')").run();
  await registerPoolSlot(env, { binding: "DB_POOL2" }); // an available slot that must NOT be consumed

  const claim = await claimWorkspace(env, { org: "DupOrg", label: "Whatever" });
  assert(claim && claim.alreadyClaimed && claim.workspace.slug === "existing", "org already claimed -> returns existing slot");
  assert(rowBySlug(db, "pool2").status === "available", "available slot not consumed for an org already claimed");
}

// ── claimWorkspace: org lookup is case-insensitive (DCS org names) ──────────
// Regression: the org lookup lacked COLLATE NOCASE, so a differently-cased
// org (e.g. detect path canonicalizes to "BSOJ" while the stored row is
// "bsoj") missed the existing claimed row and claimed a SECOND workspace for
// the same org — a duplicate-tenancy bug.
console.log("[claimWorkspace] org lookup is case-insensitive — no duplicate claim on a case-only mismatch");
{
  const db = freshDb();
  const env = makeEnv(db);
  db.prepare("INSERT INTO workspaces (slug, label, org, binding, status) VALUES ('existing', 'Existing', 'bsoj', 'DB_POOL1', 'claimed')").run();
  await registerPoolSlot(env, { binding: "DB_POOL2" }); // an available slot that must NOT be consumed

  const claim = await claimWorkspace(env, { org: "BSOJ", label: "Whatever" });
  assert(claim && claim.alreadyClaimed && claim.workspace.slug === "existing", "case-only org difference still short-circuits to the existing slot");
  assert(rowBySlug(db, "pool2").status === "available", "available slot not consumed on a case-only org match");
}

// ── claimWorkspace: a pre-existing case-variant PAIR resolves deterministically ──
// `workspaces.org` is UNIQUE under BINARY collation, so the pre-fix code could
// have left both "bsoj" and "BSOJ" claimed. The case-insensitive lookup must not
// pick between them arbitrarily — resolving to the wrong row would hand the org
// another tenant's D1 binding. The exact-case row wins.
console.log("[claimWorkspace] a case-variant pair resolves to the EXACT-case row");
{
  const db = freshDb();
  const env = makeEnv(db);
  db.prepare("INSERT INTO workspaces (slug, label, org, binding, status) VALUES ('lower', 'Lower', 'bsoj', 'DB_POOL1', 'claimed')").run();
  db.prepare("INSERT INTO workspaces (slug, label, org, binding, status) VALUES ('upper', 'Upper', 'BSOJ', 'DB_POOL2', 'claimed')").run();

  const upper = await claimWorkspace(env, { org: "BSOJ", label: "x" });
  assert(upper && upper.alreadyClaimed && upper.workspace.slug === "upper", "exact-case BSOJ resolves to the BSOJ row");
  const lower = await claimWorkspace(env, { org: "bsoj", label: "x" });
  assert(lower && lower.alreadyClaimed && lower.workspace.slug === "lower", "exact-case bsoj resolves to the bsoj row");
  // A casing that matches NEITHER row exactly still resolves (to one of them),
  // deterministically rather than arbitrarily.
  const mixed = await claimWorkspace(env, { org: "BsOj", label: "x" });
  assert(mixed && mixed.alreadyClaimed, "a third casing still short-circuits to an existing claim");
  assert(mixed.workspace.slug === "lower", "no exact match -> lowest slug, deterministic");
}

// ── claimWorkspace: input validation throws (never persists a bad row) ──────

console.log("[claimWorkspace] rejects invalid org/label without touching the pool");
{
  const db = freshDb();
  const env = makeEnv(db);
  await registerPoolSlot(env, { binding: "DB_POOL1" });

  await assertThrows(() => claimWorkspace(env, { org: "not a valid org!", label: "X" }), "invalid org throws");
  await assertThrows(() => claimWorkspace(env, { org: "OkOrg", label: "" }), "empty label throws");
  await assertThrows(() => claimWorkspace(env, { org: "OkOrg", label: "x".repeat(65) }), "over-long label throws");
  assert(rowBySlug(db, "pool1").status === "available", "no slot consumed by a rejected claim");
}

// ── claimWorkspace: a non-claimed row holding the org blocks cleanly (#382) ──
// findClaimedByOrg only sees resolvable `claimed` rows, but UNIQUE(org) spans
// EVERY status. A retired/failed/provisioning row holding the org used to make
// the claim UPDATE trip UNIQUE(org) -> 500 -> a permanently unclaimable org.
// The pre-check must refuse cleanly (a defined, non-throwing result) and consume
// no spare slot.
console.log("[claimWorkspace] a non-claimed row holding the org blocks cleanly, consuming no slot");
{
  for (const heldStatus of ["retired", "failed", "provisioning"]) {
    const db = freshDb();
    const env = makeEnv(db);
    // A row holding org X in a non-claimed status (no live binding needed — it's
    // never resolved). Plus a genuinely live available slot that must survive.
    db.prepare(
      "INSERT INTO workspaces (slug, label, org, binding, status) VALUES ('held', 'Held', 'HeldOrg', 'DB_GONE', ?)",
    ).run(heldStatus);
    await registerPoolSlot(env, { binding: "DB_POOL1" }); // must NOT be consumed

    const claim = await claimWorkspace(env, { org: "HeldOrg", label: "Whatever" });
    assert(isClaimBlocked(claim), `${heldStatus} row holding org -> defined blocked result (no throw)`);
    assert(claim.status === heldStatus, `${heldStatus}: blocked result reports the holding row's status`);
    assert(rowBySlug(db, "pool1").status === "available", `${heldStatus}: no spare slot consumed`);
    // Case-insensitively too: a differently-cased claim for the same org blocks.
    const mixed = await claimWorkspace(env, { org: "heldORG", label: "Whatever" });
    assert(isClaimBlocked(mixed), `${heldStatus}: case-variant claim for the held org also blocks`);
    assert(rowBySlug(db, "pool1").status === "available", `${heldStatus}: case-variant claim consumes no slot`);
  }
}

// ── claimWorkspace: a claimed row whose binding isn't live here blocks (#382) ─
// The variant reachable TODAY (no retirement path required): a `claimed` row
// for org X whose binding is not a live D1 on this deployment. findClaimedByOrg
// returns parseEntry(...) === null, so the org looked unclaimed and the claim
// used to trip UNIQUE(org) -> 500. Must block cleanly instead.
console.log("[claimWorkspace] a claimed-but-unresolvable-here row for the org blocks cleanly");
{
  const db = freshDb();
  const env = makeEnv(db);
  db.prepare(
    "INSERT INTO workspaces (slug, label, org, binding, status) VALUES ('dead', 'Dead', 'DeadOrg', 'DB_GONE', 'claimed')",
  ).run();
  await registerPoolSlot(env, { binding: "DB_POOL1" }); // must NOT be consumed

  const claim = await claimWorkspace(env, { org: "DeadOrg", label: "Whatever" });
  assert(isClaimBlocked(claim), "claimed row with a dead binding -> defined blocked result (not a 500)");
  assert(claim.status === "claimed", "blocked result reports status 'claimed'");
  assert(rowBySlug(db, "pool1").status === "available", "no spare slot consumed for the dead-binding claimed org");
}

// ── getPoolStatus ────────────────────────────────────────────────────────────

console.log("[getPoolStatus] reports counts and per-slot bindingLive");
{
  const db = freshDb();
  const env = makeEnv(db);
  await registerPoolSlot(env, { binding: "DB_POOL1" });
  await registerPoolSlot(env, { binding: "DB_POOL2" });
  db.prepare("INSERT INTO workspaces (slug, binding, status) VALUES ('ghost', 'DB_GONE', 'available')").run();
  await claimWorkspace(env, { org: "AlphaOrg", label: "Alpha" });

  const status = await getPoolStatus(env);
  assert(status.counts.claimed === 1, "one claimed slot counted");
  assert(status.counts.available === 2, "two available slots counted (incl. the dead-binding one)");
  assert(status.slots.length === 3, "all rows returned");
  const ghost = status.slots.find((s) => s.slug === "ghost");
  assert(ghost.bindingLive === false, "dead-binding slot reports bindingLive=false");
  const pool2 = status.slots.find((s) => s.slug === "pool2");
  assert(pool2.bindingLive === true, "live slot reports bindingLive=true");
}

console.log("workspacesPool: all assertions passed");
