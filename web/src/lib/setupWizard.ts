// Pure (React-free) helpers behind the Setup wizard's owner-confirmed flow.
// Kept in a plain .ts module (no JSX) so the node --strip-types web test runner
// can import and unit-test the load-bearing decisions directly: step gating
// after Apply, the import-error → replacement-step routing, the per-resource
// source-URL verify state machine, and the lane upstream-choice mapping.

import {
  RESOURCE_KEYS,
  type ResourceSource,
  type ResourceSourceMode,
  type ResourceSourceMap,
  type ResourceKey,
} from "./orgDraft.ts";
import { dcsName } from "./door43Url.ts";

// The wizard's step order (configure-only flow). Setup NEVER stages/overwrites
// scripture text: a populated-lane source change is rejected by the backend
// (lane_source_change_requires_migration), not quarantined here, and content
// import happens later in the editor / the forthcoming Import surface. A
// deliberate source migration is the separate "Change scripture source" tool.
export const SETUP_STEPS = {
  organization: 0,
  sources: 1,
  lanes: 2,
  review: 3,
  done: 4,
} as const;

export type SetupStepName = keyof typeof SETUP_STEPS;
export type SetupStepIndex = (typeof SETUP_STEPS)[SetupStepName];

export type LaneKey = "lit" | "sim";

// ── Per-resource source-URL verify state machine (Step 2 "Use a different
// source"). A pasted Door43 URL is verified on blur via GET
// /api/orgs/verify-source; the states drive the inline UI. ────────────────────
// `no_books` is a scripture-only outcome: the repo EXISTS but has no USFM book
// files, so it's an invalid PULL source for a lit/sim lane (nothing to translate
// from). It is treated like `invalid` (blocks Apply), NOT `unreachable`.
export type SourceVerifyErrorKind = "invalid" | "not_found" | "unreachable" | "no_books";

// A pasted URL used as a lit/sim PULL SOURCE is a source you intend to pull books
// FROM, so it must actually contain USFM — request the content check for those.
// Non-scripture roles (tn/tq/twl/tw/ta are TSV/markdown, not USFM) are
// verify-repo-exists only. The lane's own TARGET repo is NOT checked here (it's
// legitimately empty on a fresh org) — this is only the upstream=URL override.
export function shouldCheckBooks(resource: ResourceKey): boolean {
  return resource === "lit" || resource === "sim";
}

// Decide the outcome of a SUCCESSFUL repo verification (the repo exists) for a
// per-resource source override, given the optional book-content signal:
//   scripture role + hasBooks === false → REJECT as an empty scripture source
//     (no_books) — do not store it, block Apply.
//   hasBooks omitted (transient contents blip) → OK — never a false empty on a
//     DCS blip; allow proceeding.
//   non-scripture role, or hasBooks true → OK.
export interface SourceVerifyResolution {
  ok: boolean;
  errorKind?: SourceVerifyErrorKind;
}
export function resolveVerifiedSource(resource: ResourceKey, hasBooks: boolean | undefined): SourceVerifyResolution {
  if (shouldCheckBooks(resource) && hasBooks === false) {
    return { ok: false, errorKind: "no_books" };
  }
  return { ok: true };
}

export type SourceVerifyState =
  | { status: "idle" }
  | { status: "verifying" }
  | { status: "verified"; org: string; repo: string; fullName?: string }
  | { status: "error"; kind: SourceVerifyErrorKind };

// Classify the HTTP status of a failed verify-source call. A transient DCS
// failure (503) — or any unexpected status — is "unreachable" (retry), NOT
// "invalid": we must never tell the admin a real repo doesn't exist because of a
// DCS blip. 400 = garbage/unsupported host; 404 = genuine repo_not_found.
export function verifyErrorKind(httpStatus: number | undefined): SourceVerifyErrorKind {
  if (httpStatus === 400) return "invalid";
  if (httpStatus === 404) return "not_found";
  return "unreachable";
}

// ── Lane upstream choice ↔ resourceSource mode (Step 3). A lane's "Upstream for
// this lane" control (unfoldingWord / a URL / None) is the SAME per-resource
// selection Step 2 drives for the lit/sim role — keep them consistent. ─────────
export type LaneUpstreamChoice = "unfoldingWord" | "url" | "none";

export function laneChoiceFromMode(mode: ResourceSourceMode): LaneUpstreamChoice {
  return mode === "upstream" ? "unfoldingWord" : mode === "override" ? "url" : "none";
}

// The resourceSource entry a Step-2 checkbox produces when toggled. Checked =
// pull from the default upstream (mode 'upstream'); unchecked defaults to blank
// until the admin opts into an override URL.
export function toggleResourceChecked(checked: boolean): ResourceSource {
  return checked ? { mode: "upstream" } : { mode: "blank" };
}

// Selecting "A URL" for a lane's upstream (Step 3) must make the choice read as
// 'url' so the SourceOverrideField renders — an 'override' with NO repo yet does
// exactly that (laneChoiceFromMode('override') === 'url') while staying safe:
// buildTranslationSource skips an override whose repo is empty, so nothing is
// committed until a URL verifies.
export function laneUrlChoiceSelection(): ResourceSource {
  return { mode: "override" };
}

// The selection an override field resets to when its URL is cleared: back to
// upstream when the owning row is checked, otherwise blank. Prevents a cleared
// field from leaving a stale verified override in the draft. This is the ONLY
// path that blanks a resource that was pointed at a URL — a genuine user clear.
export function clearedOverrideSelection(rowChecked: boolean): ResourceSource {
  return rowChecked ? { mode: "upstream" } : { mode: "blank" };
}

// The selection to persist when a pasted URL FAILS to verify (400/404 invalid OR
// 503/unreachable transient). Critically NOT blank — a valid custom source that
// hit a DCS blip must not be silently persisted as omitted. It stays an override
// with NO repo (pending), which `isUnverifiedOverride` flags so Apply is blocked
// until the user re-verifies or explicitly clears.
export function pendingOverrideSelection(): ResourceSource {
  return { mode: "override" };
}

// A resource is an UNVERIFIED override when it's in override mode but carries no
// verified repo yet (the user pointed it at a URL that hasn't resolved). Such a
// selection must block Apply rather than silently serialize to "no source".
export function isUnverifiedOverride(sel: ResourceSource | undefined): boolean {
  if (!sel || sel.mode !== "override") return false;
  return !(sel.repo && sel.repo.trim());
}

// Every resource currently sitting on an unverified override — used to gate
// Apply/Next and to tell the user which resources still need a valid source.
export function unverifiedOverrideResources(map: ResourceSourceMap): ResourceKey[] {
  return RESOURCE_KEYS.filter((k) => isUnverifiedOverride(map[k]));
}

export function hasUnverifiedOverride(map: ResourceSourceMap): boolean {
  return unverifiedOverrideResources(map).length > 0;
}

// Default per-book replace/keep selection for the Change-Source checklist
// (issue #94). The set returned is the books to REPLACE (stage from the new
// source) by default; every other affected book is kept (carried forward).
//
// Books with work already done — any verse edited by a translator, i.e.
// stats[book].edited > 0 — default to KEPT (excluded from the returned set) so a
// plain confirm never overwrites edited/aligned content. Books with no edits
// (or with no stats available) default to REPLACE, preserving the original
// whole-lane behavior when the server sends no stats.
export function defaultReplaceSelection(
  books: ReadonlyArray<string>,
  stats?: Record<string, { verses: number; edited: number }>,
): string[] {
  return books.filter((b) => ((stats?.[b]?.edited ?? 0) === 0));
}

// The languageCode a translationSource should carry for a given upstream org:
// the org's inferred language, falling back to 'en' only when unknown. A
// non-unfoldingWord upstream must NOT keep 'en' or buildTranslationSource emits
// the wrong source language.
export function upstreamLanguageOf(inferredLanguageCode: string | null | undefined): string {
  const c = (inferredLanguageCode ?? "").trim();
  return c || "en";
}

// ── Replacement-job progress (Step 4b) ──────────────────────────────────────
// A book that hit a retryable_error / failed needs admin action (retry/waive);
// the job will otherwise sit in `staging` forever (e.g. a source repo missing a
// book's USFM → sha_unavailable). "Actionable" drives the "Action required"
// panel so a stuck job is never left waiting silently.
export function jobActionable(books: ReadonlyArray<{ status: string }>): boolean {
  return books.some((b) => b.status === "retryable_error" || b.status === "failed");
}

export type BookErrorInfo =
  | { kind: "not_found"; location: string }
  | { kind: "other"; detail: string }
  | null;

// Explain WHY a book is stuck instead of showing a bare status. The common case
// — the new source repo has no USFM for the book — surfaces as sha_unavailable;
// map it to "Not found in <owner>/<repo>@<ref>" (location resolved from the
// pending target's source) so the admin doesn't blindly retry an empty repo.
export function describeBookError(
  errorJson: string | null | undefined,
  source: { owner: string; repo: string; ref?: string } | null | undefined,
): BookErrorInfo {
  if (!errorJson) return null;
  let code: unknown = errorJson;
  try {
    const parsed = JSON.parse(errorJson);
    code = parsed?.error ?? parsed?.code ?? parsed?.reason ?? errorJson;
  } catch {
    /* not JSON — treat the raw string as the code */
  }
  const codeStr = typeof code === "string" ? code : JSON.stringify(code);
  if (codeStr.includes("sha_unavailable")) {
    const location = source
      ? `${source.owner}/${source.repo}${source.ref ? `@${source.ref}` : ""}`
      : "";
    return { kind: "not_found", location };
  }
  return { kind: "other", detail: codeStr };
}

// The canonical Door43 web URL for an org/repo — used to LINK a reader-friendly
// `org: repo` chip to the actual repository.
export function door43RepoUrl(org: string, repo: string): string {
  return `https://git.door43.org/${org}/${repo}`;
}

// ── Re-run prefill + 409 handling ────────────────────────────────────────────

// Prefill the draft's target repos from the CURRENT config ONLY when the DB is
// already configured for the org being set up (a re-run). On a FRESH org the
// live config is the DEFAULT preset (a DIFFERENT org, e.g. unfoldingWord) and
// detect()'s inference — e.g. ru_rlob — must win; prefilling would clobber it
// back to en_ult/en_ust. Same-org match is the robust "already configured" signal.
export function shouldPrefillFromCurrent(
  currentConfigOrg: string | null | undefined,
  detectedOrg: string | null | undefined,
): boolean {
  // Case-insensitive: DCS org names are. A config persisted as `bsoj` against a
  // detected `BSOJ` is the SAME org — reading it as a different one skipped the
  // prefill, so the wizard proposed a fresh-inference repo set and the apply
  // tripped the data/export identity guard.
  const a = dcsName(currentConfigOrg);
  const b = dcsName(detectedOrg);
  return a !== "" && b !== "" && a === b;
}

// The initial URL a SourceOverrideField shows: reconstruct the Door43 URL from an
// already-VERIFIED override ({mode:'override', org?, repo}) so a freshly-mounted
// field displays the verified source instead of an empty box (which a focus+blur
// would then treat as a clear and silently drop the override). Empty for a
// non-override or pending (repo-less) selection.
export function overrideFieldInitialUrl(
  sel: ResourceSource | undefined,
  defaultOrg: string,
): string {
  if (sel && sel.mode === "override" && sel.repo && sel.repo.trim() !== "") {
    return door43RepoUrl((sel.org ?? "").trim() || defaultOrg, sel.repo);
  }
  return "";
}

// A blur only CLEARS the override when the user actually emptied a field they had
// touched — never when a freshly-mounted display field just happens to be empty.
export function shouldClearOverrideOnBlur(touched: boolean, rawUrl: string): boolean {
  return touched && rawUrl.trim() === "";
}

// Apply-time 409 handling for the wizard: map the server error code (+ whether
// this is a same-org re-run) to a message key and the revert affordance to offer.
//   lane_source_change_requires_migration → per-lane revert (keep current source)
//   project_not_empty on a same-org re-run → the admin edited a repo that shifted
//     the data/export identity; offer "revert ALL repos to current" (never the
//     destroy-the-DB guidance, which only fits a genuinely different org)
//   project_not_empty for a DIFFERENT org  → the real tenancy stop (recreate DB)
export type Wizard409Revert = "lanes" | "allRepos" | "none";
export interface Wizard409 {
  messageKey: string;
  revert: Wizard409Revert;
}
export function wizardApply409(code: string | undefined, sameOrgReRun: boolean): Wizard409 {
  if (code === "lane_source_change_requires_migration") {
    return { messageKey: "setup.laneSourceMigration", revert: "lanes" };
  }
  if (code === "project_not_empty") {
    return sameOrgReRun
      ? { messageKey: "setup.identityChangedRevert", revert: "allRepos" }
      : { messageKey: "setup.projectNotEmpty", revert: "none" };
  }
  return { messageKey: "setup.laneBusy", revert: "none" };
}

// ── Populated-lane source lock (stop the migration 409 loop) ─────────────────
// The backend rejects a config PUT that changes the source of a POPULATED lane
// (lane_source_change_requires_migration), comparing the lane's ACTIVE source
// (scripture_lane_state.active_config_json.source) against the wizard's desired
// {org, repos.lit}. So on a populated project the wizard must LOCK the lane
// source to that active baseline and never propose a change.
export interface LanePublicLike {
  config?: { source?: { owner?: string; repo?: string } };
  replacementRequired?: boolean;
  populated?: boolean;
}

// A lane whose source is established (has verses, or is mid-migration) — its
// source is locked in Setup. A fresh/empty lane stays freely choosable.
export function laneSourceEstablished(ls: LanePublicLike | null | undefined): boolean {
  return !!ls && (!!ls.populated || !!ls.replacementRequired);
}

// The active source repo the wizard must lock a populated lane to (the 409
// baseline). Empty when unavailable.
export function laneActiveSourceRepo(ls: LanePublicLike | null | undefined): string {
  return ls?.config?.source?.repo ?? "";
}

// Whether the wizard CAN produce a config whose lane source equals the active
// source. desired.source.owner is always the org being configured, so an
// established lane is reconcilable ONLY when its active source owner is that same
// org AND it isn't mid-migration. The mltest drift (active owner unfoldingWord,
// or replacement_required) is NOT reconcilable — Apply must be blocked (not
// looped), directing the admin to the deliberate Change-Source tool.
//
// Owner matching is case-INSENSITIVE, matching DCS/Gitea (which resolves org
// names case-insensitively) and the backend's own `sameLaneSource`. A lane whose
// active source was persisted before org names were canonicalized against DCS
// (e.g. owner `bsoj` while detect() now reports `BSOJ`) IS the same org, and
// treating it as foreign blocked Setup permanently with no way out.
export function laneSourceReconcilable(
  ls: LanePublicLike | null | undefined,
  orgBeingConfigured: string,
): boolean {
  if (!laneSourceEstablished(ls)) return true;
  if (ls?.replacementRequired) return false;
  const owner = dcsName(ls?.config?.source?.owner);
  const org = dcsName(orgBeingConfigured);
  return owner !== "" && org !== "" && owner === org;
}

