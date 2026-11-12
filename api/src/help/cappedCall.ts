// The reserve-then-settle provider call shared by the help assistant and the
// editing assistant. The caller has already reserved `worst` on `table`
// (helpBudget.reserve); this runs the provider call and settles the real cost.
// It never rejects.

import { scrubSecrets } from "../translate/llm.ts";
import { costMicros, describeProviderError, normalizeUsage, usageIsComplete, type HelpAdapter, type HelpRequest, type HelpUsage } from "./helpChat.ts";
import { remainingMicros, settle, type UsageTable } from "./helpBudget.ts";

export type CappedParse<B> = (text: string, truncated: boolean) => { ok: true; body: B } | { ok: false; kind: string };

export type CappedOutcome<B> =
  | { ok: true; body: B; remainingMicros: number }
  | { ok: false; kind: string };

/**
 * Charge for a failed provider call. Usage attached to the error (a billed 200
 * we could not use) settles the real cost. A 4xx other than 408 is a rejection
 * that did not bill. Anything else (timeout, network, 5xx, unparseable 200) may
 * have billed, so it is charged the full reservation.
 */
export function failureCost(provider: string, err: unknown, worst: number): number {
  const u = (err as { usage?: HelpUsage } | null)?.usage;
  if (u && typeof u === "object") {
    // All-zero (or unreadable) usage on a billed reply is not believable.
    const n = normalizeUsage(u);
    return n.inputTokens + n.outputTokens + n.cacheWriteTokens + n.cacheReadTokens === 0 ? worst : costMicros(provider, n);
  }
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status <= 499 && status !== 408) return 0;
  return worst;
}

export async function runCappedCall<B>(a: {
  db: D1Database;
  table: UsageTable;
  userId: number;
  day: string;
  capMicros: number;
  provider: string;
  adapter: HelpAdapter;
  request: HelpRequest;
  /** What was reserved before this call. */
  worst: number;
  parse: CappedParse<B>;
  /** Log prefixes, e.g. { call: "help ask", budget: "help budget" }. Never log user text. */
  labels: { call: string; budget: string };
}): Promise<CappedOutcome<B>> {
  const { db, table, userId, day, provider, worst, request, labels } = a;
  const apiKey = request.apiKey;
  let actual = worst;
  let answered = false;
  let outcome: CappedOutcome<B>;
  let failure: { kind: string; status?: number } | null = null;
  try {
    const result = await a.adapter(request);
    const u = normalizeUsage(result.usage);
    // Price from usage first, so nothing after this can re-price the call.
    // A reply with an answer cannot honestly have zero output tokens.
    if (!usageIsComplete(result.usage) || u.outputTokens === 0) {
      console.warn(`${labels.call} (${provider}): provider reported no usable usage; charging the worst case`);
      actual = worst;
    } else {
      actual = costMicros(provider, u);
    }
    let parsed: ReturnType<CappedParse<B>> | null = null;
    try {
      parsed = a.parse(typeof result.text === "string" ? result.text : "", result.truncated === true);
    } catch {
      parsed = null;
    }
    console.log(`${labels.call} ok (${provider}): in=${u.inputTokens} out=${u.outputTokens} cacheW=${u.cacheWriteTokens} cacheR=${u.cacheReadTokens} micros=${actual}`);
    if (!parsed || !parsed.ok) {
      const kind = parsed && !parsed.ok ? parsed.kind : "empty_answer";
      failure = { kind };
      outcome = { ok: false, kind };
    } else {
      answered = true;
      outcome = { ok: true, body: parsed.body, remainingMicros: 0 };
    }
  } catch (err) {
    actual = failureCost(provider, err, worst);
    const status = (err as { status?: unknown } | null)?.status;
    failure = { kind: describeProviderError(err, apiKey).kind, status: typeof status === "number" ? status : undefined };
    outcome = { ok: false, kind: failure.kind };
  }
  // One attempt: settle is not idempotent, so a retry after a commit-then-error
  // could apply twice. On failure the reservation stays (it only blocks spend).
  try {
    await settle(db, userId, day, worst, actual, answered, table);
  } catch (e) {
    const m = scrubSecrets(e instanceof Error ? e.message : String(e), [apiKey]).slice(0, 300);
    console.error(`${labels.budget} settle failed (user ${userId}, ${day}, reserved ${worst}, actual ${actual}): ${m}`);
  }
  // Provider error bodies can echo the question: log only kind and status.
  if (failure) console.error(`${labels.call} failed (${provider}, ${failure.kind}${failure.status !== undefined ? `, HTTP ${failure.status}` : ""})`);
  if (outcome.ok) {
    try {
      outcome.remainingMicros = await remainingMicros(db, userId, day, a.capMicros, table);
    } catch {
      outcome.remainingMicros = 0;
    }
  }
  return outcome;
}
