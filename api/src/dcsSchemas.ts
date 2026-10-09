// Runtime schemas for the DCS (Gitea/Door43) JSON boundaries (issue #484).
//
// These replace unchecked `(await res.json()) as T` casts at the DCS read
// boundary with a real parse via httpJson.ts's parseJson/fetchJson, so a
// response whose shape doesn't match is rejected AT the boundary instead of
// flowing inward as undefined/garbage. Kept in one dependency-light module
// (zod only) so they can be unit-tested without loading the Worker runtime
// (Hono, D1 bindings, …) that importing auth.ts / dcsSources.ts would drag in.
//
// All three use a plain (non-strict) z.object/element, so Gitea's real
// responses — which carry many more fields than we read — parse fine: unknown
// keys are stripped, not rejected. Only a genuinely wrong shape (a non-array
// where a list is expected, a non-JSON error page, a mistyped field) is
// rejected, which is exactly the case the old casts silently accepted.
// Read fields are .nullish(), not .optional(): Gitea's swagger types them as
// plain string/int and Go doesn't emit null for those today, but every caller
// already treats null like absent, so accepting it costs nothing and keeps a
// future null from breaking sign-in or source loading.
//
// The OAuth token/user-profile schemas already live inline in auth.ts
// (DcsTokenResponse / DcsUserResponse); this module covers the remaining
// membership + repo-metadata boundaries.

import { z } from "zod";
import { ResponseSchemaError } from "./httpJson.ts";

// GET /api/v1/user/orgs and /api/v1/users/{user}/orgs — the org-membership
// lists behind viewer eligibility (auth.ts isViewerOrgMember). Door43's
// swagger marks Organization `username` deprecated; `name` carries the same
// value, so `name` is read first and `username` is the fallback (#572).
export const DcsOrgsResponse = z.array(
  z.object({ name: z.string().nullish(), username: z.string().nullish() }),
);

// True when the org list contains `orgName`, compared case-insensitively.
export function orgListIncludes(orgs: z.infer<typeof DcsOrgsResponse>, orgName: string): boolean {
  const want = orgName.toLowerCase();
  return orgs.some((o) => (o.name || o.username || "").toLowerCase() === want);
}

// GET /api/v1/repos/{owner}/{repo}/commits — the incremental-reimport
// freshness watermark (dcsSources.ts fileCommitSha reads commits[0].sha).
export const DcsCommitsResponse = z.array(z.object({ sha: z.string().nullish() }));

// GET /api/v1/repos/{owner}/{repo}/contents/{path} — the independent
// completeness check for the export shrink guards (dcsSources.ts dcsFileMeta
// reads the git-recorded byte `size` and blob `sha`).
export const DcsContentsMeta = z.object({
  size: z.number().nullish(),
  sha: z.string().nullish(),
});

// For the call sites above, which keep their existing fail-closed return
// (deny / null) on any error: log a schema rejection so a DCS shape change
// shows up in `wrangler tail` instead of looking like a network blip. The
// message names the boundary and the zod issue only, never request headers
// (they carry tokens). Network errors stay unlogged, as before.
export function warnOnSchemaError(err: unknown, where: string): void {
  if (err instanceof ResponseSchemaError) console.warn(`[${where}] ${err.message}`);
}
