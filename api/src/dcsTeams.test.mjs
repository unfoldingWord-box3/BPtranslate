// Unit tests for dcsTeams.ts — Door43 team membership as a role source.
//
// Two layers are exercised:
//   1. Pure mapping (roleFromTeams) and the paginated fetch (listUserTeams)
//      against an injected fetch, including the fail-closed-to-"unknown" path.
//   2. syncTeamRole against REAL SQLite (node:sqlite, same adapter shape as
//      adminUsers.test.mjs) because the manual-vs-team precedence and the
//      last-admin guard live inside single atomic SQL statements — a string
//      matching fake wouldn't actually test them.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/dcsTeams.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  listUserTeams,
  roleFromTeams,
  resolveTeamRole,
  orgForTeamSync,
  syncTeamRole,
  fetchMemberOrgs,
  teamRoleNames,
  DEFAULT_ADMIN_TEAM,
  DEFAULT_EDITOR_TEAM,
} from "./dcsTeams.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const NAMES = { admin: DEFAULT_ADMIN_TEAM, editor: DEFAULT_EDITOR_TEAM };
const team = (name, org) => ({ name, organization: { username: org } });

// ── D1 adapter over node:sqlite ───────────────────────────────────────────────

// user_roles comes from the REAL migration SQL (0016 creates it, 0055 adds
// source/synced_at, 0057 adds the manual_role stash) so the precedence tests
// below exercise the exact schema — CHECK constraints, NOCASE collation,
// defaults — production has. 0016's seed rows are cleared so each test starts
// from an empty allowlist.
const MIGRATION_0016 = readFileSync(
  new URL("../migrations/0016_user_roles.sql", import.meta.url),
  "utf8",
);
const MIGRATION_0055 = readFileSync(
  new URL("../migrations/0055_user_roles_source.sql", import.meta.url),
  "utf8",
);
const MIGRATION_0057 = readFileSync(
  new URL("../migrations/0057_user_roles_manual_stash.sql", import.meta.url),
  "utf8",
);

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(MIGRATION_0016);
  db.exec(MIGRATION_0055);
  db.exec(MIGRATION_0057);
  db.exec("DELETE FROM user_roles;");
  db.exec(`
    CREATE TABLE project_config (
      id INTEGER PRIMARY KEY,
      preset TEXT NOT NULL,
      overrides_json TEXT
    );
  `);
  return db;
}

function makeD1(db) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async run() {
              const st = db.prepare(sql);
              const r = st.run(...params);
              return { meta: { changes: Number(r.changes) } };
            },
            async first() {
              return db.prepare(sql).get(...params) ?? null;
            },
          };
        },
        async first() {
          return db.prepare(sql).get() ?? null;
        },
      };
    },
  };
}

function rolesIn(db) {
  return db
    .prepare(
      "SELECT dcs_username, role, source, synced_at, manual_role FROM user_roles ORDER BY dcs_username",
    )
    .all();
}

// Serves the given pages in order, then EMPTY pages forever — matching the
// pagination termination rule (a page shorter than the requested limit is not
// proof of the end; only an empty page is — Gitea's MAX_RESPONSE_ITEMS can cap
// pages below the limit we asked for).
function pagedFetch(...pages) {
  let i = 0;
  return async () => ({ ok: true, json: async () => (i < pages.length ? pages[i++] : []) });
}

// ── 1. Name resolution ────────────────────────────────────────────────────────

console.log("teamRoleNames");
assert(
  teamRoleNames({}).admin === "BE-Admins" && teamRoleNames({}).editor === "BE-Editors",
  "defaults to BE-Admins / BE-Editors",
);
assert(
  teamRoleNames({ DCS_TEAM_ADMIN: " Owners ", DCS_TEAM_EDITOR: "Writers" }).admin === "Owners",
  "env override wins and is trimmed",
);
assert(
  teamRoleNames({ DCS_TEAM_ADMIN: "   " }).admin === "BE-Admins",
  "blank env override falls back to the default",
);

// ── 2. roleFromTeams ──────────────────────────────────────────────────────────

console.log("roleFromTeams");
assert(roleFromTeams([], "BibleEditorMLTest", NAMES) === null, "no teams → no role");
assert(
  roleFromTeams([team("BE-Editors", "BibleEditorMLTest")], "BibleEditorMLTest", NAMES) === "editor",
  "BE-Editors → editor",
);
assert(
  roleFromTeams([team("BE-Admins", "BibleEditorMLTest")], "BibleEditorMLTest", NAMES) === "admin",
  "BE-Admins → admin",
);
assert(
  roleFromTeams(
    [team("BE-Editors", "BibleEditorMLTest"), team("BE-Admins", "BibleEditorMLTest")],
    "BibleEditorMLTest",
    NAMES,
  ) === "admin",
  "admin outranks editor regardless of order",
);
assert(
  roleFromTeams([team("be-admins", "bibleeditormltest")], "BibleEditorMLTest", NAMES) === "admin",
  "team and org names compare case-insensitively",
);
assert(
  roleFromTeams([team("BE-Admins", "SomeOtherOrg")], "BibleEditorMLTest", NAMES) === null,
  "a same-named team in ANOTHER org grants nothing",
);
assert(
  roleFromTeams([team("Owners", "BibleEditorMLTest")], "BibleEditorMLTest", NAMES) === null,
  "an unmapped team name grants nothing",
);
assert(
  roleFromTeams([{}, { organization: null }, { name: "BE-Admins" }], "BibleEditorMLTest", NAMES) === null,
  "malformed team entries are ignored, not crashed on",
);

// ── 3. listUserTeams ──────────────────────────────────────────────────────────

console.log("listUserTeams");
{
  const seen = [];
  let call = 0;
  const fakeFetch = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization });
    return {
      ok: true,
      json: async () => (call++ === 0 ? [team("BE-Editors", "BibleEditorMLTest")] : []),
    };
  };
  const teams = await listUserTeams({ DCS_BASE_URL: "https://git.door43.org/" }, "tok", {
    fetch: fakeFetch,
  });
  assert(teams.length === 1, "returns the single page of teams");
  assert(
    seen[0].url === "https://git.door43.org/api/v1/user/teams?limit=50&page=1",
    "hits /api/v1/user/teams with the trailing slash stripped from the base URL",
  );
  assert(seen[0].auth === "token tok", "authenticates with the USER's access token");
  // A page shorter than the requested limit is NOT trusted as final — Gitea's
  // MAX_RESPONSE_ITEMS can cap the server's page size below what we asked for,
  // so only an EMPTY page proves the end.
  assert(seen.length === 2, "pagination stops at the first EMPTY page, not at a short one");
}

{
  // Two full pages, a short one (server-capped, NOT the end), then empty.
  const page = (n) => Array.from({ length: n }, (_, i) => team(`T${i}`, "Org"));
  const bodies = [page(50), page(50), page(3), []];
  let calls = 0;
  const teams = await listUserTeams({}, "tok", {
    fetch: async () => ({ ok: true, json: async () => bodies[calls++] }),
  });
  assert(
    teams.length === 103 && calls === 4,
    "a short mid-list page keeps paginating; only the empty page ends it",
  );
}

{
  // Every page non-empty → the cap is hit with the list still possibly
  // incomplete. Returning the partial list would make a user whose BE-Editors
  // entry sits past the cap look like they're on no teams, and revoke them.
  const page = (n) => Array.from({ length: n }, (_, i) => team(`T${i}`, "Org"));
  let calls = 0;
  const teams = await listUserTeams({}, "tok", {
    fetch: async () => {
      calls++;
      return { ok: true, json: async () => page(50) };
    },
  });
  assert(
    teams === null && calls === 5,
    "exhausting the page cap → null (truncated ≠ complete), after MAX_PAGES requests",
  );
}

assert(
  (await listUserTeams({}, "tok", { fetch: async () => ({ ok: false, json: async () => ({}) }) })) === null,
  "non-2xx → null (unknown), not an empty list",
);
assert(
  (await listUserTeams({}, "tok", {
    fetch: async () => {
      throw new Error("network down");
    },
  })) === null,
  "network throw → null (unknown)",
);
assert(
  (await listUserTeams({}, "tok", { fetch: async () => ({ ok: true, json: async () => ({ message: "nope" }) }) })) === null,
  "non-array body → null (unknown)",
);

console.log("resolveTeamRole");
{
  const ok = await resolveTeamRole({}, "Org", "tok", {
    fetch: pagedFetch([team("BE-Admins", "Org")]),
  });
  assert(ok.known === true && ok.role === "admin", "reachable DCS → known:true with the mapped role");
  const down = await resolveTeamRole({}, "Org", "tok", { fetch: async () => ({ ok: false }) });
  assert(
    down.known === false && down.role === null,
    "unreachable DCS → known:false so the caller skips the sync entirely",
  );
}

console.log("resolveTeamRole — near-miss diagnostic for misnamed teams");
{
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    // The real-world case: the Door43 team is "BE-Admin" (singular) while the
    // configured default is "BE-Admins" — no role, but the mismatch must be
    // loudly diagnosable in `wrangler tail`, not silent.
    const res = await resolveTeamRole({}, "BibleEditorMLTest", "tok", {
      fetch: pagedFetch([team("BE-Admin", "BibleEditorMLTest"), team("Owners", "BibleEditorMLTest")]),
    });
    assert(res.known === true && res.role === null, "near-miss still resolves to no role (no aliasing)");
    const hit = warnings.find((w) => w.includes("none match the configured role teams"));
    assert(!!hit, "a near-miss logs a diagnostic warning");
    assert(
      hit.includes("BE-Admin") && hit.includes("BE-Admins") && hit.includes("BibleEditorMLTest"),
      "the warning names the org, the configured names, and the user's actual teams",
    );

    warnings.length = 0;
    const none = await resolveTeamRole({}, "BibleEditorMLTest", "tok", {
      fetch: pagedFetch([team("BE-Admin", "SomeOtherOrg")]),
    });
    assert(none.role === null, "teams only in OTHER orgs → no role");
    assert(
      !warnings.some((w) => w.includes("none match the configured role teams")),
      "no teams in the resolved org → no near-miss warning (nothing to diagnose)",
    );
  } finally {
    console.warn = realWarn;
  }
}

// ── 4. syncTeamRole ───────────────────────────────────────────────────────────

console.log("syncTeamRole — grants");
{
  const db = freshDb();
  const env = { DB: makeD1(db) };
  await syncTeamRole(env, "alice", "editor");
  assert(
    rolesIn(db)[0].role === "editor" && rolesIn(db)[0].source === "dcs_team",
    "first login in BE-Editors inserts a dcs_team row",
  );
  await syncTeamRole(env, "alice", "admin");
  assert(rolesIn(db)[0].role === "admin", "promotion in Door43 updates the cached role");
  // A second admin, so the demotion below isn't refused by the last-admin guard
  // (which is exercised on its own further down).
  db.exec("INSERT INTO user_roles (dcs_username, role, source) VALUES ('zoe','admin','manual')");
  await syncTeamRole(env, "ALICE", "editor");
  const alice = rolesIn(db).filter((r) => r.dcs_username.toLowerCase() === "alice");
  assert(
    alice.length === 1 && alice[0].role === "editor",
    "username match is case-insensitive (no duplicate row)",
  );
}

console.log("syncTeamRole — revocation");
{
  const db = freshDb();
  const env = { DB: makeD1(db) };
  db.exec("INSERT INTO user_roles (dcs_username, role, source) VALUES ('root','admin','manual')");
  await syncTeamRole(env, "bob", "editor");
  await syncTeamRole(env, "bob", null);
  assert(
    !rolesIn(db).some((r) => r.dcs_username === "bob"),
    "leaving the Door43 team removes the cached row",
  );
}

console.log("syncTeamRole — teams WIN over manual rows, stashing the manual grant for restore");
{
  const db = freshDb();
  const env = { DB: makeD1(db) };
  // A second admin so carol's demotion below isn't refused by the last-admin
  // guard (exercised on its own further down).
  db.exec("INSERT INTO user_roles (dcs_username, role, source) VALUES ('root','admin','manual')");
  db.exec("INSERT INTO user_roles (dcs_username, role, source) VALUES ('carol','admin','manual')");
  await syncTeamRole(env, "carol", "editor");
  const carol = rolesIn(db).find((r) => r.dcs_username === "carol");
  assert(carol.role === "editor", "a team signal DEMOTES a manual admin (teams win)");
  assert(carol.source === "dcs_team", "the overwritten row is now team-owned");
  assert(carol.manual_role === "admin", "the prior manual grant is STASHED, not destroyed");

  // Signal disappears (left the team — or the team was renamed/deleted, which
  // looks identical): the stashed manual grant is RESTORED, not wiped. This is
  // the org-wide-wipe guard: a team rename must degrade to the manual
  // allowlist, never to an empty one.
  await syncTeamRole(env, "carol", null);
  const carolBack = rolesIn(db).find((r) => r.dcs_username === "carol");
  assert(
    carolBack && carolBack.role === "admin" && carolBack.source === "manual",
    "signal loss RESTORES the stashed manual grant (team rename/deletion can't wipe manual rows)",
  );
  assert(carolBack.manual_role === null, "the stash is cleared on restore");
  assert(carolBack.synced_at > 0, "the restore stamps synced_at");

  // No team signal at all: an untouched manual row survives as the fallback.
  await syncTeamRole(env, "root", null);
  const root = rolesIn(db).find((r) => r.dcs_username === "root");
  assert(
    root && root.role === "admin" && root.source === "manual",
    "no team signal leaves a manual row alone — it stays the fallback grant",
  );

  // The legacy-allowlist promotion case: every row predating migration 0055 is
  // 'manual', so a pre-existing editor added to BE-Admins gets promoted — and
  // handed to team control, with the editor grant stashed.
  db.exec("INSERT INTO user_roles (dcs_username, role, source) VALUES ('legacy','editor','manual')");
  await syncTeamRole(env, "legacy", "admin");
  const legacy = rolesIn(db).find((r) => r.dcs_username === "legacy");
  assert(legacy.role === "admin", "a team promotes a manual editor to admin");
  assert(legacy.source === "dcs_team", "...and the row is now team-owned (teams win)");
  assert(legacy.manual_role === "editor", "...with the manual editor grant stashed");
  // Re-syncing while still on the team must not clobber the stash with the
  // team-written role.
  await syncTeamRole(env, "legacy", "admin");
  assert(
    rolesIn(db).find((r) => r.dcs_username === "legacy").manual_role === "editor",
    "subsequent syncs preserve the original stash (don't re-stash the team's own value)",
  );
  await syncTeamRole(env, "legacy", null);
  const legacyBack = rolesIn(db).find((r) => r.dcs_username === "legacy");
  assert(
    legacyBack.role === "editor" && legacyBack.source === "manual" && legacyBack.manual_role === null,
    "leaving the team restores the legacy editor grant",
  );

  // A pure team creation (nothing stashed) still deletes on signal loss.
  await syncTeamRole(env, "pure", "editor");
  await syncTeamRole(env, "pure", null);
  assert(
    !rolesIn(db).some((r) => r.dcs_username === "pure"),
    "a row the team created (no stash) is deleted when the signal disappears",
  );
}

console.log("syncTeamRole — last-admin guard");
{
  const db = freshDb();
  const env = { DB: makeD1(db) };
  await syncTeamRole(env, "dave", "admin");
  await syncTeamRole(env, "dave", null);
  assert(
    rolesIn(db).length === 1 && rolesIn(db)[0].role === "admin",
    "DELETE path: removing the SOLE admin from the team does not lock everyone out",
  );
  // Regression: the UPDATE path used to lack this guard entirely, so moving the
  // only admin from BE-Admins to BE-Editors emptied the admin set — and
  // /api/admin/users is admin-gated, so recovery needed raw SQL.
  await syncTeamRole(env, "dave", "editor");
  assert(
    rolesIn(db)[0].role === "admin",
    "UPDATE path: demoting the SOLE admin to editor is refused too",
  );
  await syncTeamRole(env, "erin", "admin");
  await syncTeamRole(env, "dave", "editor");
  assert(
    rolesIn(db).find((r) => r.dcs_username === "dave").role === "editor",
    "with a second admin present, the demotion goes through",
  );
  await syncTeamRole(env, "dave", null);
  assert(
    !rolesIn(db).some((r) => r.dcs_username === "dave"),
    "and so does the deletion",
  );

  // A guard-refused demotion of a MANUAL sole admin must not flip the row to
  // dcs_team either — that would hand a still-admin row to team ownership.
  const db2 = freshDb();
  const env2 = { DB: makeD1(db2) };
  db2.exec("INSERT INTO user_roles (dcs_username, role, source) VALUES ('solo','admin','manual')");
  await syncTeamRole(env2, "solo", "editor");
  const solo = rolesIn(db2)[0];
  assert(
    solo.role === "admin" && solo.source === "manual" && solo.manual_role === null,
    "refused demotion of the sole (manual) admin leaves role, source AND stash untouched",
  );

  // Guard-refused DELETE still stamps synced_at — an unstamped survivor would
  // re-trigger a DCS check on every refresh window.
  const db3 = freshDb();
  const env3 = { DB: makeD1(db3) };
  await syncTeamRole(env3, "onlyadmin", "admin");
  db3.exec("UPDATE user_roles SET synced_at = 1 WHERE dcs_username = 'onlyadmin'");
  await syncTeamRole(env3, "onlyadmin", null);
  const survivor = rolesIn(db3)[0];
  assert(
    survivor.role === "admin" && survivor.synced_at > 1,
    "guard-refused deletion of the sole admin still refreshes synced_at",
  );

  // Restore guard: the sole admin with a stashed 'editor' grant would empty
  // the admin set if restored — refuse the restore, keep the row, stamp it.
  const db4 = freshDb();
  const env4 = { DB: makeD1(db4) };
  db4.exec(
    "INSERT INTO user_roles (dcs_username, role, source, manual_role, synced_at) VALUES ('lastone','admin','dcs_team','editor',1)",
  );
  await syncTeamRole(env4, "lastone", null);
  const lastone = rolesIn(db4)[0];
  assert(
    lastone.role === "admin" && lastone.source === "dcs_team" && lastone.manual_role === "editor",
    "restoring the sole admin down to a stashed editor grant is refused (admin set never empties)",
  );
  assert(lastone.synced_at > 1, "the refused restore still refreshes synced_at");
}

console.log("syncTeamRole — synced_at freshness stamp");
{
  const db = freshDb();
  const env = { DB: makeD1(db) };
  await syncTeamRole(env, "fred", "editor");
  assert(rolesIn(db)[0].synced_at > 0, "a successful sync stamps synced_at");
  db.exec("UPDATE user_roles SET synced_at = 1 WHERE dcs_username = 'fred'");
  await syncTeamRole(env, "fred", "editor");
  assert(
    rolesIn(db)[0].synced_at > 1,
    "an unchanged role still refreshes synced_at (else refresh re-hits DCS forever)",
  );
  // A refused change must ALSO restamp, for the same reason.
  const db2 = freshDb();
  const env2 = { DB: makeD1(db2) };
  await syncTeamRole(env2, "sole", "admin");
  db2.exec("UPDATE user_roles SET synced_at = 1 WHERE dcs_username = 'sole'");
  await syncTeamRole(env2, "sole", "editor");
  assert(
    rolesIn(db2)[0].role === "admin" && rolesIn(db2)[0].synced_at > 1,
    "a guard-refused demotion still refreshes synced_at",
  );
}

console.log("orgForTeamSync");
{
  const db = freshDb();
  const env = { DB: makeD1(db) };
  assert(
    (await orgForTeamSync(env)) === null,
    "no project_config row (never onboarded) → null, so the caller skips the sync",
  );
  db.exec(
    "INSERT INTO project_config (id, preset, overrides_json) VALUES (1, 'en-unfoldingword', NULL)",
  );
  assert(
    (await orgForTeamSync(env)) === "unfoldingWord",
    "reads the org from the active preset",
  );
  db.exec(`UPDATE project_config SET overrides_json = '{"org":"BibleEditorMLTest"}' WHERE id = 1`);
  assert(
    (await orgForTeamSync(env)) === "BibleEditorMLTest",
    "an org override wins over the preset",
  );
  // The whole point: unlike getProjectConfig, a read failure must NOT silently
  // resolve to unfoldingWord — that would revoke every GL project's team roles.
  const broken = {
    DB: {
      prepare() {
        throw new Error("no such table: project_config");
      },
    },
  };
  assert(
    (await orgForTeamSync(broken)) === null,
    "a D1 error → null, NOT a silent fallback to the default preset's org",
  );
}

console.log("orgForTeamSync — workspace-aware: registry wins over project_config");
{
  const db = freshDb();
  const env = {
    DB: makeD1(db),
    WORKSPACES: JSON.stringify([
      { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB" },
    ]),
    WORKSPACE_SLUG: "org2",
  };
  // project_config claims a DIFFERENT org than the workspace registry entry —
  // the registry must win.
  db.exec(
    "INSERT INTO project_config (id, preset, overrides_json) VALUES (1, 'en-unfoldingword', NULL)",
  );
  assert(
    (await orgForTeamSync(env)) === "OrgTwo",
    "active workspace's registry org wins over project_config's org",
  );
}

console.log("orgForTeamSync — workspace-aware: fresh workspace with no project_config row");
{
  // project_config table exists (migrations ran) but has no row yet — the
  // bootstrap case for a brand-new workspace.
  const db = freshDb();
  const env = {
    DB: makeD1(db),
    WORKSPACES: JSON.stringify([
      { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB" },
    ]),
    WORKSPACE_SLUG: "org2",
  };
  assert(
    (await orgForTeamSync(env)) === "OrgTwo",
    "empty project_config still resolves the registry org, not null — this is the case that matters most",
  );
}

console.log("orgForTeamSync — WORKSPACES unset/empty: unchanged single-org production behavior");
{
  const db = freshDb();
  const env = { DB: makeD1(db), WORKSPACES: "" };
  assert(
    (await orgForTeamSync(env)) === null,
    "WORKSPACES empty + no project_config row → null (regression guard for production)",
  );
  db.exec(
    "INSERT INTO project_config (id, preset, overrides_json) VALUES (1, 'en-unfoldingword', NULL)",
  );
  assert(
    (await orgForTeamSync(env)) === "unfoldingWord",
    "WORKSPACES empty → still reads project_config as before",
  );
}

console.log("orgForTeamSync — WORKSPACES configured but WORKSPACE_SLUG matches no entry: falls back to project_config");
{
  const db = freshDb();
  const env = {
    DB: makeD1(db),
    WORKSPACES: JSON.stringify([
      { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB" },
    ]),
    WORKSPACE_SLUG: "no-such-slug",
  };
  assert(
    (await orgForTeamSync(env)) === null,
    "no matching registry entry + no project_config row → null",
  );
  db.exec(
    "INSERT INTO project_config (id, preset, overrides_json) VALUES (1, 'en-unfoldingword', NULL)",
  );
  assert(
    (await orgForTeamSync(env)) === "unfoldingWord",
    "no matching registry entry → falls back to reading project_config",
  );
}

// ── 5. fetchMemberOrgs ───────────────────────────────────────────────────────

console.log("fetchMemberOrgs");
{
  const seen = [];
  let call = 0;
  const orgs = await fetchMemberOrgs({ DCS_BASE_URL: "https://git.door43.org/" }, "tok", {
    fetch: async (url, init) => {
      seen.push({ url, auth: init.headers.Authorization });
      return {
        ok: true,
        json: async () =>
          call++ === 0 ? [{ username: "BibleEditorMLTest" }, { username: "BSOJ" }] : [],
      };
    },
  });
  assert(
    seen[0].url === "https://git.door43.org/api/v1/user/orgs?limit=50&page=1",
    "hits /api/v1/user/orgs with the trailing slash stripped",
  );
  assert(seen[0].auth === "token tok", "authenticates with the USER's access token");
  assert(
    orgs.has("bibleeditormltest") && orgs.has("bsoj") && orgs.size === 2,
    "returns a lowercased org-name set",
  );
  assert(seen.length === 2, "pagination stops at the first EMPTY page, not at a short one");
}
{
  // #572: `username` is deprecated in Door43's swagger; `name` alone must count.
  let call = 0;
  const orgs = await fetchMemberOrgs({}, "tok", {
    fetch: async () => ({
      ok: true,
      json: async () => (call++ === 0 ? [{ name: "BSOJ" }, { name: "afii", username: null }, {}] : []),
    }),
  });
  assert(orgs.has("bsoj") && orgs.has("afii") && orgs.size === 2, "orgs with only `name` are members");
}
{
  // Two full pages, a short (server-capped) one, then empty — all followed.
  const page = (n, prefix) => Array.from({ length: n }, (_, i) => ({ username: `${prefix}${i}` }));
  const bodies = [page(50, "a"), page(50, "b"), page(3, "c"), []];
  let calls = 0;
  const orgs = await fetchMemberOrgs({}, "tok", {
    fetch: async () => ({ ok: true, json: async () => bodies[calls++] }),
  });
  assert(
    orgs.size === 103 && calls === 4,
    "a short mid-list page keeps paginating; only the empty page ends it",
  );
}
{
  // Cap exhausted with pages still non-empty → unknown, not a truncated set.
  const page = (n) => Array.from({ length: n }, (_, i) => ({ username: `o${i}` }));
  const orgs = await fetchMemberOrgs({}, "tok", {
    fetch: async () => ({ ok: true, json: async () => page(50) }),
  });
  assert(orgs === null, "exhausting the page cap → null (truncated ≠ complete)");
}
assert(
  (await fetchMemberOrgs({}, "tok", { fetch: async () => ({ ok: false }) })) === null,
  "non-2xx → null (unknown), not an empty set",
);
assert(
  (await fetchMemberOrgs({}, "tok", {
    fetch: async () => {
      throw new Error("network down");
    },
  })) === null,
  "network throw → null (unknown)",
);
assert(
  (await fetchMemberOrgs({}, "tok", { fetch: async () => ({ ok: true, json: async () => ({ message: "nope" }) }) })) === null,
  "non-array body → null (unknown)",
);

console.log("all dcsTeams tests passed");
