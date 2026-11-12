// Per-user daily spend cap for the help assistant (migration 0077).
// All money is integer micro-dollars (1 USD = 1,000,000) so the cap check never
// meets float rounding. The cap is checked and the worst-case cost reserved in
// ONE statement, before any provider call; settle() then swaps the reservation
// for the real cost.

import { priceFor } from "./helpPrices.ts";

type Db = D1Database;

export const DEFAULT_CAP_USD = 2;

/**
 * The usage table a budget call works on. Interpolated into SQL, so it is a
 * closed union: never pass a string that came from input.
 */
export type UsageTable = "help_chat_usage" | "assistant_chat_usage";

/** Parse a daily-cap env var; 0 means no AI spend; missing, non-numeric or negative falls back to `defaultUsd` ($2 for help). */
export function capMicrosFromEnv(raw: string | undefined, defaultUsd: number = DEFAULT_CAP_USD): number {
  const n = Number(raw);
  const usd = raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : defaultUsd;
  return Math.round(usd * 1_000_000);
}

/** True for the error D1 raises when migration 0077 has not been applied. */
export function isMissingSchemaError(e: unknown): boolean {
  return /no such (table|column)/i.test(e instanceof Error ? e.message : String(e));
}

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Next UTC midnight, ISO string. */
export function nextResetIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

/** Per-message allowance for role markers and framing tokens. */
const MESSAGE_OVERHEAD_TOKENS = 20;

/**
 * Upper bound on input tokens: one token per UTF-8 byte (a byte-level
 * tokenizer never spends less than a byte per token) plus framing per message.
 * chars/3 under-counts Arabic, which would let a call settle above its
 * reservation and push spend past the cap.
 */
export function inputTokenBound(texts: string[]): number {
  const enc = new TextEncoder();
  return texts.reduce((n, t) => n + enc.encode(t).length + MESSAGE_OVERHEAD_TOKENS, 0);
}

/**
 * Highest this call could cost: `inputTokens` (from inputTokenBound) priced at
 * the provider's highest input rate (the cache-write rate for claude), plus a
 * full max_tokens of output.
 */
export function worstCaseMicros(
  provider: string,
  inputTokens: number,
  maxOutput: number,
): number {
  const p = priceFor(provider);
  const inRate = Math.max(p.input, p.cacheWrite ?? 0);
  return Math.ceil((inputTokens * inRate + maxOutput * p.output) / 100);
}

/** True iff the reservation fit under the cap and was recorded. */
export async function reserve(
  db: Db,
  userId: number,
  day: string,
  micros: number,
  capMicros: number,
  table: UsageTable = "help_chat_usage",
): Promise<boolean> {
  await db
    .prepare(`INSERT INTO ${table} (user_id, day) VALUES (?1, ?2) ON CONFLICT(user_id, day) DO NOTHING`)
    .bind(userId, day)
    .run();
  const r = await db
    .prepare(
      `UPDATE ${table} SET reserved_micros = reserved_micros + ?1
        WHERE user_id = ?2 AND day = ?3 AND spent_micros + reserved_micros + ?1 <= ?4`,
    )
    .bind(micros, userId, day, capMicros)
    .run();
  return r.meta.changes === 1;
}

/**
 * Release the reservation and record what was spent. `answered` is true only
 * when the call returned an answer; it alone increments `calls`.
 */
export async function settle(
  db: Db,
  userId: number,
  day: string,
  reservedMicros: number,
  actualMicros: number,
  answered: boolean,
  table: UsageTable = "help_chat_usage",
): Promise<void> {
  await db
    .prepare(
      `UPDATE ${table}
          SET reserved_micros = MAX(reserved_micros - ?1, 0),
              spent_micros = spent_micros + ?2,
              calls = calls + ?5
        WHERE user_id = ?3 AND day = ?4`,
    )
    .bind(reservedMicros, actualMicros, userId, day, answered ? 1 : 0)
    .run();
}

export async function remainingMicros(
  db: Db,
  userId: number,
  day: string,
  capMicros: number,
  table: UsageTable = "help_chat_usage",
): Promise<number> {
  const row = await db
    .prepare(`SELECT spent_micros, reserved_micros FROM ${table} WHERE user_id = ?1 AND day = ?2`)
    .bind(userId, day)
    .first<{ spent_micros: number; reserved_micros: number }>();
  const used = row ? row.spent_micros + row.reserved_micros : 0;
  return Math.max(0, capMicros - used);
}
