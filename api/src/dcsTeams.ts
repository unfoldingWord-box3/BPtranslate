// Reads Door43 (Gitea) team membership and maps it to an app role.
//
// This is the READ-ONLY half of "Door43 teams as role source" (docs/deferred.md):
// teams are created and managed in Door43's own team UI; the editor never writes
// membership. At OAuth callback we ask DCS which teams the signing-in user
// belongs to (with the *user's own* access token — no elevated service-token
// scope needed), keep only the teams inside the configured project org, and map
// the team name to admin/editor. The result is cached into `user_roles` so the
// refresh path (api/src/auth.ts) keeps working off a plain D1 read.
//
// Team names are conventional, not hardcoded policy: DCS_TEAM_ADMIN /
// DCS_TEAM_EDITOR override them per environment, mirroring the VIEWER_ORG idiom
// already used for the viewer-org check.

import type { Env } from "./index";
import type { Role } from "./auth.ts";
import { materialize } from "./projectConfig.ts";
import { activeWorkspaceOrg } from "./workspaces.ts";

export const DEFAULT_ADMIN_TEAM = "BE-Admins";
export const DEFAULT_EDITOR_TEAM = "BE-Editors";

export interface TeamRoleNames {
  admin: string;
  editor: string;
}

export function teamRoleNames(env: Env): TeamRoleNames {
  return {
    admin: (env.DCS_TEAM_ADMIN ?? "").trim() || DEFAULT_ADMIN_TEAM,
    editor: (env.DCS_TEAM_EDITOR ?? "").trim() || DEFAULT_EDITOR_TEAM,
  };
}

export interface DcsTeam {
  name?: string;
  organization?: { username?: string } | null;
}

// Gitea caps page size; 50 matches listOrgRepos in orgInference.ts. A user in
// more than MAX_PAGES*PAGE_SIZE teams is not a real case — the cap just bounds
// the worst case on a login round-trip. Exhausting the cap is treated as an
// INCOMPLETE answer (null), not as a complete one: a truncated list that
// happens to omit the project org's team would otherwise look exactly like
// "not on any team" and revoke a legitimate role.
const PAGE_SIZE = 50;
const MAX_PAGES = 5;

// Shared paginated GET against a DCS list endpoint, authenticated with the
// user's own token. Termination rule: keep fetching until an EMPTY page.
// A page merely shorter than our requested PAGE_SIZE is NOT proof of the end —
// Gitea's MAX_RESPONSE_ITEMS can cap the server's page size below what we
// asked for, so a server-capped "full" page would masquerade as a final short
// one and silently truncate the list. The price is one extra (empty-page)
// request per complete listing; the alternative was misreading membership.
//
// Returns null — "unknown", never an empty list — on ANY failure: network,
// non-2xx, unparseable body, or the page cap exhausted with items still
// coming. Callers must never read null as "no memberships".
async function fetchPagedList<T>(
  env: Env,
  path: string,
  label: string,
  accessToken: string,
  deps?: { fetch?: typeof fetch },
): Promise<T[] | null> {
  const doFetch = deps?.fetch ?? fetch;
  const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
  const items: T[] = [];
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await doFetch(
        `${base}${path}?limit=${PAGE_SIZE}&page=${page}`,
        { headers: { Authorization: `token ${accessToken}`, Accept: "application/json" } },
      );
      if (!res.ok) {
        // Logged, not silent: a persistent 403 here (e.g. the OAuth grant not
        // carrying org-read scope) would otherwise be indistinguishable, from
        // the outside, from "no memberships". `wrangler tail` is the intended
        // diagnostic.
        console.warn(`[dcsTeams] ${label} page ${page} returned ${res.status}`);
        return null;
      }
      const batch = (await res.json()) as unknown;
      if (!Array.isArray(batch)) {
        console.warn(`[dcsTeams] ${label} returned a non-array body`);
        return null;
      }
      if (batch.length === 0) return items;
      items.push(...(batch as T[]));
    }
  } catch (err) {
    console.warn(`[dcsTeams] ${label} fetch failed: ${String(err)}`);
    return null;
  }
  // Ran out of pages with items still arriving — the list may be truncated,
  // so we don't know the user's full membership. Unknown, not complete.
  console.warn(`[dcsTeams] ${label} exceeded ${MAX_PAGES} pages; treating as unknown`);
  return null;
}

// A cached team role is re-checked against DCS this often (see maybeResync in
// api/src/auth.ts). Without it, removing someone from a Door43 team wouldn't
// take effect until their next *full* sign-in — up to the 14-day refresh
// window — because refresh reads only user_roles.
export const RESYNC_AFTER_SECONDS = 3600;

/**
 * GET /api/v1/user/teams for the signed-in user.
 *
 * Returns `null` on ANY failure (network, non-2xx, unparseable body). Callers
 * MUST treat null as "unknown", not as "no teams" — a DCS outage must never be
 * read as a revocation, or every login during the outage would strip cached
 * team roles out of `user_roles`.
 */
export async function listUserTeams(
  env: Env,
  accessToken: string,
  deps?: { fetch?: typeof fetch },
): Promise<DcsTeam[] | null> {
  return fetchPagedList<DcsTeam>(env, "/api/v1/user/teams", "/user/teams", accessToken, deps);
}

/**
 * GET /api/v1/user/orgs with the user's own token — the set of Door43 orgs
 * they belong to, lowercased for case-insensitive compare against workspace
 * org names. (In Gitea, team membership implies org membership, so this set
 * is sufficient for workspace matching.)
 *
 * Returns `null` (never an empty set) on ANY failure — see fetchPagedList —
 * so callers can distinguish "confirmed no orgs" from "couldn't check". The
 * latter must fail soft (keep the current/cookie workspace, keep cached
 * roles), never hard to "denied everywhere".
 *
 * Shared by the OAuth callback's login-time workspace resolution (auth.ts)
 * and the workspace switcher (workspaceRoutes.ts).
 */
export async function fetchMemberOrgs(
  env: Env,
  accessToken: string,
  deps?: { fetch?: typeof fetch },
): Promise<Set<string> | null> {
  const list = await fetchPagedList<{ name?: string | null; username?: string | null }>(
    env,
    "/api/v1/user/orgs",
    "/user/orgs",
    accessToken,
    deps,
  );
  if (list === null) return null;
  const orgs = new Set<string>();
  // `name` and the deprecated `username` are both the org login (#572).
  for (const o of list) {
    for (const v of [o?.name, o?.username]) {
      const login = (typeof v === "string" ? v : "").toLowerCase();
      if (login) orgs.add(login);
    }
  }
  return orgs;
}

/**
 * Highest role granted by the user's teams *within `org`*. Team names and org
 * names both compare case-insensitively (Gitea itself is case-insensitive on
 * org names). Membership in neither team → null.
 */
export function roleFromTeams(
  teams: DcsTeam[],
  org: string,
  names: TeamRoleNames,
): Role | null {
  const wantOrg = org.trim().toLowerCase();
  const adminTeam = names.admin.toLowerCase();
  const editorTeam = names.editor.toLowerCase();
  let role: Role | null = null;
  for (const t of teams) {
    if ((t?.organization?.username ?? "").toLowerCase() !== wantOrg) continue;
    const name = (t?.name ?? "").trim().toLowerCase();
    if (name === adminTeam) return "admin"; // highest — nothing can beat it
    if (name === editorTeam) role = "editor";
  }
  return role;
}

/** Convenience: fetch + map. `null` means "no team role, or DCS didn't answer". */
export async function resolveTeamRole(
  env: Env,
  org: string,
  accessToken: string,
  // `deps.teams` supplies an ALREADY-FETCHED /user/teams listing (the login
  // path fetches one for pool auto-claim before this runs, and the listing is
  // user-global, not org-scoped, so it is valid for any org). Present-and-null
  // means DCS didn't answer — the same "unknown" this function returns for a
  // failed fetch, never "no teams". Absent means fetch it here as before.
  deps?: { fetch?: typeof fetch; teams?: DcsTeam[] | null },
): Promise<{ known: boolean; role: Role | null }> {
  const teams = deps?.teams !== undefined ? deps.teams : await listUserTeams(env, accessToken, deps);
  if (teams === null) return { known: false, role: null };
  const names = teamRoleNames(env);
  const role = roleFromTeams(teams, org, names);
  if (role === null) {
    // Near-miss diagnostic: the user IS on teams in this org, just none whose
    // name matches the configured admin/editor team names. Without this line
    // a misnamed team (real case: a Door43 team created as "BE-Admin" while
    // the default is the plural "BE-Admins") silently degrades every member
    // to viewer/denied and is indistinguishable, from the outside, from "not
    // on any team". `wrangler tail` is the intended diagnostic; the fix is to
    // rename the team or set DCS_TEAM_ADMIN / DCS_TEAM_EDITOR.
    const wantOrg = org.trim().toLowerCase();
    const inOrg = teams
      .filter((t) => (t?.organization?.username ?? "").toLowerCase() === wantOrg)
      .map((t) => (t?.name ?? "").trim())
      .filter(Boolean);
    if (inOrg.length > 0) {
      console.warn(
        `[dcsTeams] user has teams in org "${org}" but none match the configured role teams ` +
          `(admin="${names.admin}", editor="${names.editor}"); their teams there: ${inOrg.join(", ")}`,
      );
    }
  }
  return { known: true, role };
}

// The last-admin guard predicate for the teams-win UPSERT below, shared by
// its role AND source CASEs so the two can never desynchronize (a refused
// demotion must leave BOTH untouched — flipping only source would hand a
// still-admin row to team ownership). `user_roles.*` = the pre-update row,
// `excluded.*` = the incoming team value; valid only inside the upsert's
// DO UPDATE clause.
const UPSERT_LAST_ADMIN_GUARD = `(user_roles.role = 'admin' AND excluded.role = 'editor'
                AND (SELECT COUNT(*) FROM user_roles WHERE role = 'admin') <= 1)`;

/**
 * Sync the team-derived role into `user_roles` so /api/auth/refresh (which
 * re-reads that table) needs no DCS round-trip on every request.
 *
 * Precedence, stated as one rule: **Door43 teams win; a manual grant is a
 * fallback that resurfaces only when the team signal disappears.**
 *
 *  - A team role (admin/editor) OVERWRITES the row — role AND source — even
 *    when the existing row was a manual allowlist grant. Once a user has a
 *    team signal, Door43 is authoritative for them in both directions:
 *    promotion, demotion, and removal. When the row being taken over was
 *    `source = 'manual'`, its prior role is STASHED in `manual_role`
 *    (migration 0057) so the grant isn't destroyed, just superseded.
 *  - No team signal (`role === null`, membership positively known):
 *      * a `dcs_team` row with a stashed `manual_role` is RESTORED to
 *        (role = manual_role, source = 'manual', manual_role = NULL) — so a
 *        Door43 team rename or deletion (indistinguishable from "everyone
 *        left the team") degrades to the pre-team manual allowlist instead of
 *        wiping it org-wide;
 *      * a pure team creation (`manual_role` NULL) is deleted;
 *      * a `manual` row team sync never claimed is untouched.
 *  - The last remaining admin is never demoted OR deleted — on the overwrite,
 *    restore, AND delete paths — matching the guards in adminUserRoutes.ts.
 *    Leaving a Door43 team must not be able to empty the admin set:
 *    `/api/admin/users` is itself admin-gated, so a zero-admin project can
 *    only be repaired with raw SQL against D1. A guard-refused change leaves
 *    role, source, and manual_role all untouched.
 *
 * `synced_at` is stamped on every sync outcome — grant, restore, guard-refused
 * change, even a no-op — so the refresh path can tell a freshly-checked row
 * from a stale one (an unstamped survivor would re-hit DCS every window).
 */
export async function syncTeamRole(
  env: Env,
  dcsUsername: string,
  role: Role | null,
): Promise<void> {
  if (role === "admin" || role === "editor") {
    // The role decision is a CASE inside SET rather than a WHERE on the whole
    // UPDATE so that `synced_at` is refreshed even when the role is unchanged
    // or the change is refused — otherwise a declined update would leave the
    // row permanently stale and re-hit DCS on every single refresh. All SET
    // expressions evaluate against the PRE-update row, so manual_role's CASE
    // sees the original source/role regardless of assignment order.
    await env.DB.prepare(
      `INSERT INTO user_roles (dcs_username, role, source, synced_at)
       VALUES (?1, ?2, 'dcs_team', unixepoch())
       ON CONFLICT(dcs_username) DO UPDATE SET
         synced_at = unixepoch(),
         manual_role = CASE
           WHEN NOT ${UPSERT_LAST_ADMIN_GUARD} AND user_roles.source = 'manual'
             THEN user_roles.role
           ELSE user_roles.manual_role
         END,
         role = CASE
           WHEN NOT ${UPSERT_LAST_ADMIN_GUARD} THEN excluded.role
           ELSE user_roles.role
         END,
         source = CASE
           WHEN NOT ${UPSERT_LAST_ADMIN_GUARD} THEN 'dcs_team'
           ELSE user_roles.source
         END`,
    )
      .bind(dcsUsername, role)
      .run();
    return;
  }
  // No team signal (positively known). Three statements, in order:
  // 1. restore rows with a stashed manual grant (guard: restoring the sole
  //    admin down to a stashed 'editor' would empty the admin set — refuse);
  await env.DB.prepare(
    `UPDATE user_roles SET
       role = manual_role,
       source = 'manual',
       manual_role = NULL,
       synced_at = unixepoch()
     WHERE dcs_username = ?1 AND source = 'dcs_team' AND manual_role IS NOT NULL
       AND NOT (role = 'admin' AND manual_role = 'editor'
                AND (SELECT COUNT(*) FROM user_roles WHERE role = 'admin') <= 1)`,
  )
    .bind(dcsUsername)
    .run();
  // 2. delete pure team creations (restored rows are now source='manual' and
  //    unreachable here);
  await env.DB.prepare(
    `DELETE FROM user_roles
      WHERE dcs_username = ?1
        AND source = 'dcs_team'
        AND manual_role IS NULL
        AND NOT (role = 'admin' AND (SELECT COUNT(*) FROM user_roles WHERE role = 'admin') <= 1)`,
  )
    .bind(dcsUsername)
    .run();
  // 3. stamp any guard-refused survivor — a dcs_team row still standing after
  //    the two statements above was refused by a last-admin guard, and leaving
  //    it unstamped would trigger a DCS re-check on every refresh window.
  await env.DB.prepare(
    `UPDATE user_roles SET synced_at = unixepoch()
      WHERE dcs_username = ?1 AND source = 'dcs_team'`,
  )
    .bind(dcsUsername)
    .run();
}

/**
 * The org to match teams against — read straight from D1 rather than through
 * getProjectConfig, which deliberately swallows read errors and falls back to
 * the default (unfoldingWord/en) preset. That fallback is right for import and
 * export paths but catastrophic here: matching a GL project's users against
 * unfoldingWord's teams would revoke every team-derived role on a transient D1
 * hiccup, and could grant admin to an unfoldingWord BE-Admins member on a
 * project they have nothing to do with.
 *
 * Returns null when the org can't be established (read failed, or the project
 * has never been onboarded) — callers must skip the sync entirely, not guess.
 *
 * When workspaces are configured (one D1 per Door43 org — see workspaces.ts),
 * the roster entry for the ACTIVE workspace wins over the project_config read.
 * Two reasons: the roster is the authoritative statement of which org this
 * database belongs to, and a freshly created workspace has no project_config
 * row yet — the read below would return null and silently skip team sync for
 * exactly the org someone is trying to bootstrap. Falling back to
 * project_config keeps single-workspace deployments behaving exactly as before;
 * note VIEWER_ORG is NOT a safe substitute there, since in a single-org
 * deployment it is a separate viewer-access setting that need not equal the
 * project's own org — which is precisely the line activeWorkspaceOrg draws
 * (explicit roster entry vs. the synthetic implicit default).
 *
 * That check used to be gated on the WORKSPACES env var being non-empty, which
 * silently stopped covering the registry: a workspace claimed from the spare
 * pool at first admin login (#81) exists only as a registry row, and production
 * runs WORKSPACES = "" — so the org of the very workspace being bootstrapped
 * was unresolvable and its first admin fell through to viewer.
 */
export async function orgForTeamSync(env: Env): Promise<string | null> {
  const active = activeWorkspaceOrg(env);
  if (active) return active;
  try {
    const row = await env.DB.prepare(
      "SELECT preset, overrides_json FROM project_config WHERE id = 1",
    ).first<{ preset: string; overrides_json: string | null }>();
    if (!row) return null;
    return materialize(row.preset, row.overrides_json).org || null;
  } catch {
    return null;
  }
}

/**
 * Full pipeline for one user: resolve the org this env belongs to, ask DCS
 * which teams they're on, cache the mapped role into user_roles.
 *
 * `env` decides WHICH workspace's org is matched and WHICH database is
 * written — callers switching/landing a user in a non-request workspace must
 * pass the derived `workspaceEnv(...)`, not the request env.
 *
 * NOTHING here may break sign-in. Every failure mode — DCS unreachable, the
 * project org unknown, a D1 error (notably `no such column: source` in the
 * window between deploying the worker and applying migration 0055, since code
 * normally ships before migrations) — must leave the existing allowlist exactly
 * as it was and let the caller fall through to the pre-existing gate. A thrown
 * error here would 500 the OAuth callback and lock EVERY user out, admins
 * included, which is strictly worse than the feature silently not applying.
 */
export async function syncTeamRoleForUser(
  env: Env,
  dcsUsername: string,
  accessToken: string,
  deps?: { fetch?: typeof fetch; teams?: DcsTeam[] | null },
): Promise<void> {
  try {
    const org = await orgForTeamSync(env);
    if (!org) return; // project never onboarded, or the config read failed
    const team = await resolveTeamRole(env, org, accessToken, deps);
    if (!team.known) return; // DCS didn't answer — never read that as "no teams"
    await syncTeamRole(env, dcsUsername, team.role);
  } catch (err) {
    console.warn(`[dcsTeams] team role sync failed for ${dcsUsername}: ${String(err)}`);
  }
}
