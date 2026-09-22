// Runtime schema validation for JSON at the API boundaries (issue #484).
//
// TypeScript types are erased at build time, so `(await res.json()) as T`
// asserts a shape that nothing checks — the compiler agrees with us and the
// runtime is free to disagree. This module turns those casts into a real
// parse: a payload that does not match the schema is rejected here, at the
// boundary, instead of being carried inward and caught (or missed) by a
// downstream heuristic. That is the general form of the defenses already
// hand-rolled against one instance of the problem (the export freshness gate
// and shrink-guard, added after a truncated/stale DCS response reached
// master — see CLAUDE.md).
//
// Two entry points, so an existing call site keeps its own status handling:
//   parseJson(res, schema, endpoint) — for callers that already hold a
//     Response and own the res.ok / status branch (e.g. the OAuth callback,
//     which maps a non-2xx to a specific error code). Parses the body and
//     validates it against `schema`.
//   fetchJson(url, schema, init) — the all-in-one the issue calls for: fetch,
//     reject a non-ok status, then parseJson. For new/simple decode-and-use
//     call sites.
//
// Both throw ResponseSchemaError naming the endpoint and the zod issue, so the
// caller can log or retry with the failing boundary identified. The failure
// posture (retry the step, surface a 502, degrade) is deliberately the
// caller's to choose — a malformed DCS response during nightly export must
// fail-and-retry, never render partially; a bad OAuth reply is a 502.

import type { ZodType } from "zod";

export class ResponseSchemaError extends Error {
  /** A human-readable label for the boundary that produced the bad payload. */
  readonly endpoint: string;
  /** What was wrong: "body was not valid JSON", "HTTP 502", or the zod issues. */
  readonly detail: string;
  /** The HTTP status of the offending response, when one was received. */
  readonly status?: number;
  constructor(endpoint: string, detail: string, status?: number) {
    super(`response from ${endpoint} failed validation: ${detail}`);
    this.name = "ResponseSchemaError";
    this.endpoint = endpoint;
    this.detail = detail;
    this.status = status;
  }
}

/**
 * Parse and validate an already-fetched Response body against `schema`.
 * Does NOT inspect res.ok — the caller owns HTTP status handling.
 * @throws ResponseSchemaError on a non-JSON body or a schema mismatch.
 */
export async function parseJson<T>(res: Response, schema: ZodType<T>, endpoint: string): Promise<T> {
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new ResponseSchemaError(endpoint, "body was not valid JSON", res.status);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ResponseSchemaError(endpoint, detail, res.status);
  }
  return result.data;
}

/**
 * Fetch `url`, reject a non-ok HTTP status, then parse + validate the body.
 * @throws ResponseSchemaError on a non-ok status, a non-JSON body, or a
 *   schema mismatch. Network errors from `fetch` propagate unchanged.
 */
export async function fetchJson<T>(url: string, schema: ZodType<T>, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new ResponseSchemaError(url, `HTTP ${res.status}`, res.status);
  }
  return parseJson(res, schema, url);
}
