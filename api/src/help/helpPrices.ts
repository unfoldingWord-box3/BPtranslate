// Own price table for the help assistant's cap (USD per 1M tokens). Separate
// from translate/providerCatalog.ts on purpose: the catalog's Haiku price is
// stale (#548) and this table also carries Claude cache rates.
//
// USD per 1M tokens equals micro-dollars per token, so a call costs
// tokens * price micro-dollars. Prices are held x100 as integers so cache-read
// 0.10 and cache-write 1.25 never touch float math.

/**
 * Per-provider max output tokens. Gemini, OpenAI and xAI count thinking /
 * reasoning tokens inside this limit, so they get more room than Claude (which
 * runs without thinking here).
 */
const MAX_OUTPUT: Record<string, number> = { claude: 1024, gemini: 2048, openai: 2048, xai: 2048 };

export function maxOutputFor(provider: string): number {
  if (!Object.prototype.hasOwnProperty.call(MAX_OUTPUT, provider)) throw new Error(`no help output budget for provider ${provider}`);
  return MAX_OUTPUT[provider];
}

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

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/** Missing, negative or non-numeric token counts become 0, so costMicros can never return NaN. */
export function normalizeUsage(u: Partial<HelpUsage> | null | undefined): HelpUsage {
  return {
    inputTokens: count(u?.inputTokens),
    outputTokens: count(u?.outputTokens),
    cacheWriteTokens: count(u?.cacheWriteTokens),
    cacheReadTokens: count(u?.cacheReadTokens),
  };
}

/** True iff all four counts are finite numbers (a provider that omitted one did not report honestly). */
export function usageIsComplete(u: Partial<HelpUsage> | null | undefined): boolean {
  return [u?.inputTokens, u?.outputTokens, u?.cacheWriteTokens, u?.cacheReadTokens].every((n) => typeof n === "number" && Number.isFinite(n));
}

/**
 * Actual cost in whole micro-dollars (rounded up). Claude prices cache write and
 * read tokens at their own rates; every other provider prices all input tokens
 * at the full input rate (no cache discount: over-counting is the safe side).
 */
export function costMicros(provider: string, usage: HelpUsage): number {
  const p = priceFor(provider);
  const u = normalizeUsage(usage);
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
