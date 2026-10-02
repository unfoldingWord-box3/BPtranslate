// Own price table for the help assistant's cap (USD per 1M tokens). Separate
// from translate/providerCatalog.ts on purpose: the catalog's Haiku price is
// stale (#548) and this table also carries Claude cache rates.
//
// USD per 1M tokens equals micro-dollars per token, so a call costs
// tokens * price micro-dollars. Prices are held x100 as integers so cache-read
// 0.10 and cache-write 1.25 never touch float math.

export const HELP_MAX_OUTPUT_TOKENS = 1024;

export type HelpUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

type Price = { input: number; output: number; cacheWrite?: number; cacheRead?: number };

const usd = (x: number) => Math.round(x * 100);

const PRICES: Record<string, Price> = {
  claude: { input: usd(1), output: usd(5), cacheWrite: usd(1.25), cacheRead: usd(0.1) },
  gemini: { input: usd(0.75), output: usd(3.75) },
  openai: { input: usd(0.2), output: usd(1.2) },
  xai: { input: usd(1.25), output: usd(2.5) },
};

export function priceFor(provider: string): Price {
  if (!Object.prototype.hasOwnProperty.call(PRICES, provider)) throw new Error(`no help price for provider ${provider}`);
  return PRICES[provider];
}

/**
 * Actual cost in whole micro-dollars (rounded up). Claude prices cache write and
 * read tokens at their own rates; every other provider prices all input tokens
 * at the full input rate (no cache discount: over-counting is the safe side).
 */
export function costMicros(provider: string, u: HelpUsage): number {
  const p = priceFor(provider);
  let centi: number;
  if (provider === "claude") {
    centi =
      u.inputTokens * p.input +
      u.cacheWriteTokens * (p.cacheWrite ?? p.input) +
      u.cacheReadTokens * (p.cacheRead ?? p.input) +
      u.outputTokens * p.output;
  } else {
    centi = (u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens) * p.input + u.outputTokens * p.output;
  }
  return Math.ceil(centi / 100);
}
