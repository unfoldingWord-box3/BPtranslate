// #551: AI translation runs on the organization's own AI key or not at all.
// POST /api/pipelines/start answers 409 { error: "ai_provider_not_configured" }
// when a translate job is started for an org with no key. Every screen that
// starts a translate run maps it to the same plain message, the i18n key
// "pipeline.aiKeyNotConfigured", instead of showing the raw code or reading
// the 409 as "already running".

export const AI_PROVIDER_NOT_CONFIGURED = "ai_provider_not_configured";

/** True when a thrown start error (an ApiError) carries the "no org AI key" code. */
export function isAiProviderNotConfigured(e: unknown): boolean {
  return errorCodeOf(e) === AI_PROVIDER_NOT_CONFIGURED;
}

// #551 switch-off: these AI features still run on unfoldingWord's shared
// account, because the bot can't take an organization's own key for them yet:
//   - the older pipeline types generate / notes / tqs (Generate ULT and UST,
//     Write translation notes, Write translation questions);
//   - Draft with AI / Suggest / Redo on a single verse note (POST /api/tn-quick);
//   - Draft with AI on note templates, one or many (POST /api/templates/unit/draft).
// The server refuses all three with 409 { error: "ai_needs_org_key" }, and the
// buttons are disabled up front with the i18n message "ai.needsOrgKey".
// Intro/general-note Redo is not affected: it runs the translate pipeline on
// the org's key.
export const AI_NEEDS_ORG_KEY = "ai_needs_org_key";

/** Pipeline types switched off until they can run on the org's own key. */
export const PIPELINE_TYPES_NEEDING_ORG_KEY: ReadonlySet<string> = new Set(["generate", "notes", "tqs"]);

/** Note and template "Draft with AI" are switched off. Flip to false when a
 *  rebuild lets them run on the org's own key (and drop the server refusal in
 *  api/src/tnQuick.ts and api/src/templates.ts). */
export const QUICK_DRAFTS_NEED_ORG_KEY: boolean = true;

/** True when a thrown error (an ApiError) carries the "needs the org key" code. */
export function isAiNeedsOrgKey(e: unknown): boolean {
  return errorCodeOf(e) === AI_NEEDS_ORG_KEY;
}

function errorCodeOf(e: unknown): unknown {
  const body = e && typeof e === "object" ? (e as { body?: unknown }).body : undefined;
  return body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
}
