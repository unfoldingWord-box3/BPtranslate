// The row in a 409 version_mismatch body (`current`, the row as it is now),
// or null when the error is anything else: another 409 (chapter_locked,
// workspace_mismatch), another status, or not an API error at all. A
// version_mismatch with no usable row is null too; every row route that
// answers version_mismatch sends `current`.
//
// Duck-typed on the shape of sync/api.ts's ApiError ({ status, body }) so it
// stays importable from the node test runner, like aiProviderErrors.ts.
export function versionMismatchRow<T extends { id: string }>(err: unknown): T | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { status?: unknown; body?: unknown };
  if (e.status !== 409) return null;
  const b = e.body as { error?: unknown; current?: unknown } | null | undefined;
  if (!b || typeof b !== "object" || b.error !== "version_mismatch") return null;
  const cur = b.current as T | null | undefined;
  return cur && typeof cur === "object" && typeof cur.id === "string" ? cur : null;
}
