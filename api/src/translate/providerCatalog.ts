// providerCatalog.ts — model ids, aliases and list prices for the BYO-key
// providers the in-Worker translate runner can call.
//
// A slice of bp-assistant src/api-runner/provider-config.js (issue #445,
// design §A): only the providers in aiProvider.ts AI_PROVIDERS and only the
// model ids aiProvider.ts PROVIDER_MODELS lets an admin store — plus the
// aliases from the bot catalog whose targets are inside that set. Dropped:
// the JSON override file + mtime cache (fs), difficulty tiers, BP_* env pins,
// autoModelByThinking routing, fallback chains, reasoningEffortModels.
// `defaultModel` is the editor's UI suggestion (first PROVIDER_MODELS entry),
// not the bot's default — the editor never dispatches without a stored model,
// so it only matters for `resolveProviderModel(provider, null)`.
//
// `estimateCost` (translate-llm.js:530-541) lives here because it is a pure
// catalog lookup; the LLM adapters (step 2) import it.
//
// Prices are USD per 1M tokens as listed in the bot catalog on 2026-09-15,
// except the Claude entries: those were checked against Anthropic's pricing
// page (platform.claude.com/docs/en/about-claude/pricing) on 2026-10-05 and
// deliberately differ from the bot catalog, which still had Haiku 4.5 at
// $0.80/$4 and Sonnet 5 at $3/$15 (issue #548). Verify against the vendor
// price page before relying on a report's estimatedCostUsd for billing.

export type ModelPrice = { label: string; inputPer1M: number; outputPer1M: number };

export type ProviderConfig = {
  defaultModel: string;
  baseUrl?: string;
  modelAliases: Record<string, string>;
  models: Record<string, ModelPrice>;
};

export type CatalogProvider = "claude" | "openai" | "gemini" | "xai";

export const PROVIDER_CATALOG: Record<CatalogProvider, ProviderConfig> = {
  claude: {
    defaultModel: "claude-sonnet-5",
    modelAliases: {
      opus: "claude-opus-5",
      haiku: "claude-haiku-4-5-20251001",
      "claude-haiku-4-5": "claude-haiku-4-5-20251001",
    },
    models: {
      "claude-opus-5": { label: "Claude Opus 5", inputPer1M: 5.0, outputPer1M: 25.0 },
      "claude-sonnet-5": { label: "Claude Sonnet 5", inputPer1M: 2.0, outputPer1M: 10.0 },
      "claude-haiku-4-5-20251001": { label: "Claude Haiku 4.5", inputPer1M: 1.0, outputPer1M: 5.0 },
    },
  },
  openai: {
    defaultModel: "gpt-5.6-terra",
    modelAliases: {},
    models: {
      "gpt-5.5": { label: "GPT 5.5", inputPer1M: 5.0, outputPer1M: 30.0 },
      "gpt-5.6-sol": { label: "GPT 5.6 Sol", inputPer1M: 5.0, outputPer1M: 30.0 },
      "gpt-5.6-terra": { label: "GPT 5.6 Terra", inputPer1M: 2.0, outputPer1M: 12.0 },
      "gpt-5.6-luna": { label: "GPT 5.6 Luna", inputPer1M: 0.2, outputPer1M: 1.2 },
    },
  },
  gemini: {
    defaultModel: "gemini-3.6-flash",
    modelAliases: {
      opus: "gemini-3.1-pro-preview",
    },
    models: {
      "gemini-3.1-pro-preview": { label: "Gemini 3.1 Pro (preview)", inputPer1M: 1.25, outputPer1M: 10.0 },
      "gemini-3.6-flash": { label: "Gemini 3.6 Flash", inputPer1M: 1.5, outputPer1M: 7.5 },
      // Promotional pricing through 2026-12-31 (Google's model page); both
      // 3.7 and 3.8 Flash are $0.75 in / $3.75 out at every context length.
      "gemini-3.7-flash": { label: "Gemini 3.7 Flash", inputPer1M: 0.75, outputPer1M: 3.75 },
      "gemini-3.8-flash": { label: "Gemini 3.8 Flash", inputPer1M: 0.75, outputPer1M: 3.75 },
    },
  },
  xai: {
    defaultModel: "grok-4.5",
    baseUrl: "https://api.x.ai/v1",
    modelAliases: {},
    models: {
      "grok-4.5": { label: "Grok 4.5", inputPer1M: 2.0, outputPer1M: 6.0 },
      "grok-4.3": { label: "Grok 4.3", inputPer1M: 1.25, outputPer1M: 2.5 },
    },
  },
};

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function getProviderConfig(provider: string): ProviderConfig {
  if (!hasOwn(PROVIDER_CATALOG, provider)) throw new Error(`Unknown provider: ${provider}`);
  return PROVIDER_CATALOG[provider as CatalogProvider];
}

export function getProviderNames(): CatalogProvider[] {
  return Object.keys(PROVIDER_CATALOG) as CatalogProvider[];
}

/** Alias-resolve a model id (or the provider default when none is given). */
export function resolveProviderModel(provider: string, model: string | null | undefined): string {
  const cfg = getProviderConfig(provider);
  const candidate = model || cfg.defaultModel;
  // hasOwnProperty guard: an unguarded cfg.modelAliases[candidate] read lets
  // candidate values like "toString"/"constructor"/"__proto__" resolve to an
  // inherited Object.prototype member instead of undefined, bypassing validation.
  if (hasOwn(cfg.modelAliases, candidate)) return cfg.modelAliases[candidate];
  return candidate;
}

export function isConfiguredModel(provider: string, model: unknown): boolean {
  if (!model || typeof model !== "string") return false;
  const cfg = getProviderConfig(provider);
  // hasOwnProperty guard — see resolveProviderModel above for the same reason.
  return hasOwn(cfg.models, model);
}

/** Resolve + validate; throws naming the valid aliases and models when unknown. */
export function assertProviderModel(provider: string, model: string | null | undefined): string {
  const cfg = getProviderConfig(provider);
  const resolved = resolveProviderModel(provider, model);
  if (isConfiguredModel(provider, resolved)) return resolved;

  const validAliases = Object.keys(cfg.modelAliases);
  const validModels = Object.keys(cfg.models);
  throw new Error(
    `Unknown ${provider} model "${model}". Valid aliases: ${validAliases.join(", ") || "(none)"}; valid models: ${validModels.join(", ")}`,
  );
}

export type TokenUsage = { inputTokens?: number; outputTokens?: number };

/** Catalog-priced cost for one call. Null when the model has no pricing entry. */
export function estimateCost(provider: string, model: string | null | undefined, usage: TokenUsage | null | undefined): number | null {
  let cfg: ProviderConfig;
  try {
    cfg = getProviderConfig(provider);
  } catch {
    return null;
  }
  const resolved = resolveProviderModel(provider, model);
  const m = hasOwn(cfg.models, resolved) ? cfg.models[resolved] : undefined;
  if (!m || m.inputPer1M == null || m.outputPer1M == null) return null;
  return ((usage?.inputTokens || 0) / 1e6) * m.inputPer1M + ((usage?.outputTokens || 0) / 1e6) * m.outputPer1M;
}
