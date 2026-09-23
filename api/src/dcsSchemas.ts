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
//
// The OAuth token/user-profile schemas already live inline in auth.ts
// (DcsTokenResponse / DcsUserResponse); this module covers the remaining
// membership + repo-metadata boundaries.

import { z } from "zod";

// GET /api/v1/user/orgs and /api/v1/users/{user}/orgs — the org-membership
// lists behind viewer eligibility (auth.ts isViewerOrgMember). Only `username`
// is read (compared case-insensitively against the viewer org).
export const DcsOrgsResponse = z.array(z.object({ username: z.string().optional() }));

// GET /api/v1/repos/{owner}/{repo}/commits — the incremental-reimport
// freshness watermark (dcsSources.ts fileCommitSha reads commits[0].sha).
export const DcsCommitsResponse = z.array(z.object({ sha: z.string().optional() }));

// GET /api/v1/repos/{owner}/{repo}/contents/{path} — the independent
// completeness check for the export shrink guards (dcsSources.ts dcsFileMeta
// reads the git-recorded byte `size` and blob `sha`).
export const DcsContentsMeta = z.object({
  size: z.number().optional(),
  sha: z.string().optional(),
});
