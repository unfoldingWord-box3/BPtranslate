// Diagnostic record of a rejected row write (409 version_mismatch). See
// migrations/0074_row_conflict_log.sql for why it exists and what each column
// answers. Best-effort: a logging failure must never change the 409 the client
// gets, so the insert runs under waitUntil and swallows its own errors.

export interface RowConflictInput {
  kind: string;
  rowId: string;
  book: string | null;
  action: "patch" | "delete";
  userId: number | null;
  expectedVersion: number;
  fields: string[];
  // The row as the 409 path re-read it (SELECT * or a narrower SELECT).
  current: Record<string, unknown> | null | undefined;
  headers: {
    opQueuedAt?: string | null;
    clientRoute?: string | null;
    tabId?: string | null;
  };
}

// Header values are client-controlled: clamp them so a hostile or buggy client
// can't bloat the table.
function clampText(v: string | null | undefined, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null;
}

/** Positional bind values for ROW_CONFLICT_INSERT_SQL. Pure, for tests. */
export function rowConflictBindValues(input: RowConflictInput): unknown[] {
  const queuedRaw = clampText(input.headers.opQueuedAt, 20);
  const queued = queuedRaw !== null && /^\d+$/.test(queuedRaw) ? Number(queuedRaw) : null;
  const cur = input.current ?? null;
  return [
    input.kind,
    input.rowId,
    input.book,
    input.action,
    input.userId,
    input.expectedVersion,
    intOrNull(cur?.version),
    intOrNull(cur?.updated_by),
    intOrNull(cur?.updated_at),
    JSON.stringify(input.fields),
    queued,
    clampText(input.headers.clientRoute, 120),
    clampText(input.headers.tabId, 64),
  ];
}

export const ROW_CONFLICT_INSERT_SQL = `INSERT INTO row_conflict_log
  (kind, row_id, book, action, user_id, expected_version, current_version,
   current_updated_by, current_updated_at, fields_json, op_queued_at, client_route, tab_id)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`;

interface ConflictLogContext {
  env: { DB: D1Database };
  executionCtx: { waitUntil(p: Promise<unknown>): void };
  req: { header(name: string): string | undefined };
}

export function logRowConflict(
  c: ConflictLogContext,
  input: Omit<RowConflictInput, "headers">,
): void {
  const values = rowConflictBindValues({
    ...input,
    headers: {
      opQueuedAt: c.req.header("x-op-queued-at"),
      clientRoute: c.req.header("x-client-route"),
      tabId: c.req.header("x-tab-id"),
    },
  });
  c.executionCtx.waitUntil(
    c.env.DB.prepare(ROW_CONFLICT_INSERT_SQL)
      .bind(...values)
      .run()
      .catch((err: unknown) => {
        console.warn("row_conflict_log insert failed", err);
      }),
  );
}
