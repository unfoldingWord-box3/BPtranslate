// Parity between the models an admin can pick here (PROVIDER_MODELS in
// aiProvider.ts) and the models the translate bot (unfoldingWord/bp-assistant,
// model-provider-config.json) accepts. The bot rejects an id it does not know
// with model_not_found, so a model offered here but missing there fails every
// translate job for the org that picked it (#677).
//
// Pure comparison only; botModels.check.mjs fetches the bot's file and calls it.

/** One provider block of the bot's model-provider-config.json (only the fields read here). */
export type BotProviderConfig = {
  models?: Record<string, unknown>;
  modelAliases?: Record<string, string>;
};

/** The bot's model-provider-config.json (only the fields read here). */
export type BotModelConfig = {
  providers?: Record<string, BotProviderConfig>;
};

/** `aliasOf` is set when the id is a bot alias whose target is not a bot model. */
export type MissingModel = { provider: string; model: string; aliasOf?: string };

// Own keys only, so "constructor" or "toString" never reads as a known model.
const has = (obj: object | undefined, key: string): boolean =>
  obj != null && Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Every (provider, model) we offer that the bot would reject. Mirrors the bot's
 * assertProviderModel (src/api-runner/provider-config.js): an alias key is
 * resolved one level first, then the result must be a key of `models`. So an
 * alias whose target is missing (a dangling alias) is rejected too, and is
 * reported with `aliasOf`. A provider the bot lacks entirely makes all of its
 * models missing.
 */
export function findModelsMissingFromBot(
  ours: Record<string, readonly string[]>,
  bot: BotModelConfig,
): MissingModel[] {
  const missing: MissingModel[] = [];
  for (const [provider, models] of Object.entries(ours)) {
    const block = has(bot.providers, provider) ? bot.providers?.[provider] : undefined;
    for (const model of models) {
      if (has(block?.modelAliases, model)) {
        const target = block?.modelAliases?.[model];
        if (typeof target !== "string" || !has(block?.models, target)) {
          missing.push({ provider, model, aliasOf: String(target) });
        }
      } else if (!has(block?.models, model)) {
        missing.push({ provider, model });
      }
    }
  }
  return missing;
}
