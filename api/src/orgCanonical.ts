// Org-name canonicalization against DCS. Extracted from orgRoutes.ts so the
// org-name WRITE paths (claimWorkspace in workspaces.ts, applyProjectConfig in
// projectConfigApply.ts) can canonicalize casing without importing the Hono
// route module — orgRoutes → auth → workspaces is a live import chain, so a
// route-module import here would close a cycle. This module depends only on the
// `Env` type and the leaf dcsSchemas.ts, so any caller can pull it in freely.
import type { Env } from "./index";
import { orgLogin } from "./dcsSchemas.ts";

// Looks an org up on DCS via GET /api/v1/orgs/{org} (Gitea org lookups are
// case-insensitive). Returns the canonical record ({username, fullName}) on a
// 200, or null on 404 / any non-200 / network error. Unlike canonicalOrgName
// this DISTINGUISHES "exists" from "does not" — the org-search endpoint needs
// that distinction (a clean match vs. an empty result), whereas org detection
// only wants canonical casing and fails open.
export async function lookupOrgRecord(
  env: Env,
  org: string,
): Promise<{ username: string; fullName: string } | null> {
  try {
    const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (env.DCS_SERVICE_TOKEN) headers.Authorization = `token ${env.DCS_SERVICE_TOKEN}`;
    const res = await fetch(`${base}/api/v1/orgs/${encodeURIComponent(org)}`, { headers });
    if (!res.ok) return null;
    const body = (await res.json()) as { name?: string; username?: string; full_name?: string };
    const username = orgLogin(body);
    if (!username) return null;
    return { username, fullName: body.full_name ?? username };
  } catch {
    return null;
  }
}

// Resolves an org name to DCS's canonical casing via GET /api/v1/orgs/{org}
// (Gitea's `name` field, or the deprecated `username`). Fails open to the input as-typed on any
// non-200 response or network error — same tolerance as the per-user lookup
// in adminUserRoutes.ts, since a lookup hiccup here must not block org
// detection when listOrgRepos already confirmed the org exists. Because it
// fails open, the case-insensitive comparisons at read time must stay: this is
// best-effort normalization on write, not a guarantee of canonical casing.
export async function canonicalOrgName(env: Env, org: string): Promise<string> {
  const rec = await lookupOrgRecord(env, org);
  return rec?.username || org;
}
