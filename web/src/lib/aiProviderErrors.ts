// #551: AI translation runs on the organization's own AI key or not at all.
// POST /api/pipelines/start answers 409 { error: "ai_provider_not_configured" }
// when a translate job is started for an org with no key. Every screen that
// starts a translate run maps it to the same plain message, the i18n key
// "pipeline.aiKeyNotConfigured", instead of showing the raw code or reading
// the 409 as "already running".

export const AI_PROVIDER_NOT_CONFIGURED = "ai_provider_not_configured";

/** True when a thrown start error (an ApiError) carries the "no org AI key" code. */
export function isAiProviderNotConfigured(e: unknown): boolean {
  const body = e && typeof e === "object" ? (e as { body?: unknown }).body : undefined;
  return (
    !!body &&
    typeof body === "object" &&
    (body as { error?: unknown }).error === AI_PROVIDER_NOT_CONFIGURED
  );
}
