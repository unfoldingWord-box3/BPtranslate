import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import type { CheckLane, RowKind, TnRow, TqRow, TwlRow } from "./types";
import { currentUserId, requireEditor } from "./auth.ts";
import { activePipelineForChapter, lockedResponseBody } from "./chapterLock.ts";
import { broadcastChapter } from "./wsEvents.ts";
import { newRowId } from "./rowId.ts";
import { reopenLaneChecks } from "./laneReopen.ts";
import { refParts, coveredVersesFromRef } from "./importParsers.ts";
import { contentPatchClearClauses } from "./contentPatchClauses.ts";
import { normalizeBookCode, CHAPTER_EXISTS_SQL } from "./rowsCreateGuard.ts";
import { isValidTwlRefRaw } from "./twlRefGuard.ts";
import { boundHistoryToLastCreate } from "./rowHistoryBoundary.ts";
import { logRowConflict } from "./rowConflictLog.ts";

export const rows = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

const KIND_TO_TABLE: Record<RowKind, string> = {
  tn: "tn_rows",
  tq: "tq_rows",
  twl: "twl_rows",
};

const isRowKind = (k: string): k is RowKind => k in KIND_TO_TABLE;

// "Edits reopen the checkoff": a successful tn/tq write reopens its own lane
// ('tn'/'tq'). twl is intentionally null — adding/removing a TWL link is the
// Words work itself, not an edit that should reopen the Words sign-off ('tw').
const KIND_TO_REOPEN_LANE: Record<RowKind, CheckLane | null> = {
  tn: "tn",
  tq: "tq",
  twl: null,
};

// The original-language field per kind — the cell whose Hebrew/Greek content
// forces Occurrence >= 1 (see origLangOccurrence below).
const QUOTE_FIELD: Record<RowKind, "quote" | "orig_words"> = {
  tn: "quote",
  tq: "quote",
  twl: "orig_words",
};

// uW TSV invariant: an original-language (Hebrew/Greek) quote must carry
// Occurrence >= 1. The editor / AI quote-builder can rewrite a Gateway-Language
// snippet to OL words without touching occurrence, leaving it null/0, which
// exports as invalid TSV. Mirrors export.ts's guard (the export side is the
// last-resort net; this fixes the stored row at the source). Keep the two in
// sync. Unicode blocks: Hebrew (0590-05FF), Hebrew presentation forms
// (FB1D-FB4F), Greek and Coptic (0370-03FF), Greek Extended (1F00-1FFF).
function hasOrigLang(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      (c >= 0x0590 && c <= 0x05ff) ||
      (c >= 0xfb1d && c <= 0xfb4f) ||
      (c >= 0x0370 && c <= 0x03ff) ||
      (c >= 0x1f00 && c <= 0x1fff)
    )
      return true;
  }
  return false;
}

// Adds a book filter to a WHERE clause. After the composite-(book, id) PK
// migration (0015), every row lookup MUST be scoped by book — the same 4-char
// id can exist in two books with different content. Handlers guarantee a
// non-null book before threading the value through to bind position `paramN`.
function bookClause(paramN: number): string {
  return ` AND book = ?${paramN}`;
}

// Re-select a row after a write, carrying the same derived `latest_source`
// column chapters.ts computes on read (tn/tq only — twl has no AI chip). A
// plain `SELECT *` omits it, and the client REPLACES its whole cached row
// with whatever this endpoint returns (both the direct PATCH response and
// the row.upserted WS broadcast) rather than merging — so returning a row
// without this column wiped out an accurate "AI" chip on every write,
// including non-versioning ones like a reorder's sort_order-only patch,
// where the true latest_source (edit_log is untouched) hadn't changed at
// all. Computing it here keeps the response honest either way: unchanged
// across a reorder, correctly cleared to NULL after a real content edit.
async function selectRowWithLatestSource(
  env: Env,
  kind: RowKind,
  id: string,
  book: string,
): Promise<Record<string, unknown> | null> {
  if (kind === "twl") {
    return env.DB.prepare(`SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1${bookClause(2)}`)
      .bind(id, book)
      .first();
  }
  return env.DB.prepare(
    `SELECT t.*, (
       SELECT source FROM edit_log
        WHERE kind = ?3 AND row_key = t.id
          AND (book = t.book OR book IS NULL)
        ORDER BY id DESC LIMIT 1
     ) AS latest_source
        FROM ${KIND_TO_TABLE[kind]} t
       WHERE t.id = ?1${bookClause(2)}`,
  )
    .bind(id, book, kind)
    .first();
}

// Reuse the Hono request lifecycle to pull "expected version" off the
// If-Match header. We accept a bare integer ("If-Match: 7") for simplicity.
function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  // Accept bare integers or quoted ETags; reject anything else so a
  // malformed header isn't silently treated as "no precondition".
  const m = /^"?(\d+)"?$/.exec(trimmed);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

const TnPatch = z.object({
  ref_raw: z.string().optional(),
  // Retarget a note to a different verse within its chapter (the "change
  // reference" action). chapter stays implicit — the move UI is same-chapter
  // only — so the broadcast on a successful PATCH still covers one chapter.
  // Sent alongside a recomputed ref_raw + sort_order, so it never hits the
  // reorder-only fast path and correctly bumps the version + logs history.
  verse: z.number().int().nonnegative().optional(),
  tags: z.string().nullable().optional(),
  support_reference: z.string().nullable().optional(),
  quote: z.string().nullable().optional(),
  occurrence: z.number().int().nullable().optional(),
  note: z.string().nullable().optional(),
  sort_order: z.number().nullable().optional(),
});

const TqPatch = z.object({
  ref_raw: z.string().optional(),
  tags: z.string().nullable().optional(),
  quote: z.string().nullable().optional(),
  occurrence: z.number().int().nullable().optional(),
  question: z.string().nullable().optional(),
  response: z.string().nullable().optional(),
});

const TwlPatch = z.object({
  ref_raw: z.string().optional(),
  tags: z.string().nullable().optional(),
  orig_words: z.string().nullable().optional(),
  occurrence: z.number().int().nullable().optional(),
  tw_link: z.string().nullable().optional(),
  sort_order: z.number().nullable().optional(),
});

const PATCH_SCHEMA = { tn: TnPatch, tq: TqPatch, twl: TwlPatch };

// Row-id generation/validation/repair live in rowId.ts (pure leaf module, shared
// with pipelineImport's id validation and the reimport's coerceRowId guard).

const CreateTn = z.object({
  book: z.string(),
  chapter: z.number().int().nonnegative(),
  verse: z.number().int().nonnegative(),
  ref_raw: z.string(),
  tags: z.string().nullable().optional(),
  support_reference: z.string().nullable().optional(),
  quote: z.string().nullable().optional(),
  occurrence: z.number().int().nullable().optional(),
  note: z.string().nullable().optional(),
  sort_order: z.number().nullable().optional(),
});
const CreateTq = z.object({
  book: z.string(),
  chapter: z.number().int().nonnegative(),
  verse: z.number().int().nonnegative(),
  ref_raw: z.string(),
  tags: z.string().nullable().optional(),
  quote: z.string().nullable().optional(),
  occurrence: z.number().int().nullable().optional(),
  question: z.string().nullable().optional(),
  response: z.string().nullable().optional(),
});
const CreateTwl = z.object({
  book: z.string(),
  chapter: z.number().int().nonnegative(),
  verse: z.number().int().nonnegative(),
  ref_raw: z.string(),
  tags: z.string().nullable().optional(),
  orig_words: z.string().nullable().optional(),
  occurrence: z.number().int().nullable().optional(),
  tw_link: z.string().nullable().optional(),
  sort_order: z.number().nullable().optional(),
});
const CREATE_SCHEMA = { tn: CreateTn, tq: CreateTq, twl: CreateTwl };

// Hardcoded per-kind allowlist of INSERT-able column names. The create path
// interpolates column names directly into the SQL string (D1 can't bind
// identifiers), so the set of names must NEVER be derived from request-shaped
// data. Today the closed Zod schemas above already bound the keys, but this
// allowlist is a defense-in-depth gate so a future schema widening can't open
// a SQL-injection path through `Object.keys(data)`. Each entry must mirror the
// corresponding Create* schema's fields (sort_order is server-defaulted but
// still a valid column). Keep these two lists in sync.
const INSERT_COLS: Record<RowKind, readonly string[]> = {
  tn: [
    "book", "chapter", "verse", "ref_raw", "tags", "support_reference",
    "quote", "occurrence", "note", "sort_order",
  ],
  tq: [
    "book", "chapter", "verse", "ref_raw", "tags", "quote", "occurrence",
    "question", "response",
  ],
  twl: [
    "book", "chapter", "verse", "ref_raw", "tags", "orig_words", "occurrence",
    "tw_link", "sort_order",
  ],
};

rows.post("/:kind", requireEditor, async (c) => {
  const kind = c.req.param("kind");
  if (!isRowKind(kind)) return c.json({ error: "invalid_kind" }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = CREATE_SCHEMA[kind].safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body", details: parsed.error.format() }, 400);
  const data = parsed.data as Record<string, unknown>;

  // See rowsCreateGuard.ts for why both of these are needed and what each
  // one closes off (upstream issue #491).
  data.book = normalizeBookCode(data.book as string);
  const chapterExists = await c.env.DB.prepare(CHAPTER_EXISTS_SQL)
    .bind(data.book, data.chapter)
    .first<{ ok: number }>();
  if (!chapterExists) return c.json({ error: "not_found", reason: "unknown_chapter" }, 404);

  const userId = currentUserId(c);

  // Block new rows while an AI pipeline is running for this chapter — the
  // auto-apply step will overwrite or rearrange the row set when it lands.
  const lock = await activePipelineForChapter(
    c.env,
    parsed.data.book,
    parsed.data.chapter,
  );
  if (lock) return c.json(lockedResponseBody(lock), 409);

  // A new row must carry a sort_order. Without one it lands NULL, and the
  // export's `ORDER BY ... sort_order ASC NULLS LAST, id` dumps it at the end
  // of its verse keyed by id — scrambling file order in the nightly DCS diff
  // (pure-reorder churn). Honor a client-supplied value; otherwise place the
  // row at the end of its verse (max + 100), matching the import spacing.
  if (data.sort_order == null) {
    const maxRow = await c.env.DB.prepare(
      `SELECT MAX(sort_order) AS m FROM ${KIND_TO_TABLE[kind]}
        WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND deleted_at IS NULL`,
    )
      .bind(data.book, data.chapter, data.verse)
      .first<{ m: number | null }>();
    data.sort_order = (maxRow?.m ?? 0) + 100;
  }

  // Retry around PK collision: insert under a fresh id and let the DB be the
  // source of truth instead of SELECT-then-INSERT (which races between two
  // concurrent POSTs). 32^4 ≈ 1M ids; ~8 tries covers any plausible book.
  // Build the column list from the hardcoded allowlist, not from
  // Object.keys(data), so a request can never inject an identifier. Only keys
  // actually present in `data` are included (preserving the prior behavior
  // where unsupplied optional fields fall through to DB defaults). The
  // matching values are read in the SAME order so placeholders line up.
  const dataCols = INSERT_COLS[kind].filter((name) =>
    Object.prototype.hasOwnProperty.call(data, name),
  );
  const cols = ["id", ...dataCols, "updated_by"];
  const placeholders = cols.map((_c, i) => `?${i + 1}`).join(", ");
  let id = "";
  let lastErr: unknown = null;
  for (let i = 0; i < 8; i++) {
    id = newRowId();
    const values: unknown[] = [id, ...dataCols.map((name) => data[name]), userId];
    try {
      await c.env.DB.batch([
        c.env.DB
          .prepare(
            `INSERT INTO ${KIND_TO_TABLE[kind]} (${cols.join(", ")}) VALUES (${placeholders})`,
          )
          .bind(...values),
        c.env.DB
          .prepare(
            `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json) VALUES (?1, ?2, ?3, ?4, NULL, 1, 'create', ?5)`,
          )
          .bind(kind, id, data.book, userId, JSON.stringify(data)),
      ]);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      // Only retry on a unique-constraint collision. Anything else is a real
      // failure that should bubble up.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/UNIQUE|PRIMARY KEY/i.test(msg)) throw e;
    }
  }
  if (lastErr) {
    return c.json({ error: "id_collision_exhausted" }, 503);
  }

  const created = await c.env.DB.prepare(
    `SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1 AND book = ?2`,
  )
    .bind(id, data.book)
    .first();
  if (created) {
    const row = created as unknown as TnRow | TqRow | TwlRow;
    c.executionCtx.waitUntil(
      broadcastChapter(c.env, row.book, row.chapter, { type: "row.upserted", kind, row }),
    );
    const lane = KIND_TO_REOPEN_LANE[kind];
    if (lane) {
      // Reopen the lane on every verse a bridged ref covers (not just the
      // leading verse), matching where the note now renders. Singletons → one.
      const verses = coveredVersesFromRef(row.ref_raw, row.verse);
      c.executionCtx.waitUntil(
        Promise.all(verses.map((v) => reopenLaneChecks(c.env, row.book, row.chapter, v, [lane]))),
      );
    }
  }
  return c.json(created, 201);
});

rows.get("/:kind/:id", async (c) => {
  const kind = c.req.param("kind");
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!isRowKind(kind)) return c.json({ error: "invalid_kind" }, 400);
  if (!book) return c.json({ error: "book_required" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1${bookClause(2)}`,
  )
    .bind(id, book)
    .first<TnRow | TqRow | TwlRow>();
  if (!row || row.deleted_at) return c.json({ error: "not_found" }, 404);
  return c.json(row);
});

// Per-kind content fields that the history endpoint exposes in each
// version's snapshot. Identity fields (book/chapter/verse/ref_raw) and
// transient fields like sort_order are deliberately omitted — they aren't
// what users mean when they say "switch to an older version".
const HISTORY_FIELDS: Record<RowKind, string[]> = {
  tn: ["quote", "note", "support_reference", "occurrence", "tags"],
  tq: ["quote", "question", "response", "occurrence", "tags"],
  twl: ["orig_words", "tw_link", "occurrence", "tags"],
};

// Replay edit_log entries forward to reconstruct the snapshot of each
// version. `create` carries the full posted body; `update` carries only the
// patch. Either way we merge into a running snapshot so the value at
// version N is whatever survived after the Nth log entry.
//
// Imported rows never went through POST so they have no `create` entry. We
// detect this and synthesize a v1 baseline from the current row's content.
// For never-patched fields this baseline is exact; for fields that were
// edited later, the synthesized v1 still reflects the current value (the
// real pre-edit value is lost), but the higher-version reconstructions are
// correct because patches always override the baseline going forward.
rows.get("/:kind/:id/history", requireEditor, async (c) => {
  const kind = c.req.param("kind");
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!isRowKind(kind)) return c.json({ error: "invalid_kind" }, 400);
  if (!book) return c.json({ error: "book_required" }, 400);

  const currentRow = await c.env.DB.prepare(
    `SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1${bookClause(2)}`,
  )
    .bind(id, book)
    .first<Record<string, unknown> & { version: number; deleted_at: number | null; updated_at: number }>();
  if (!currentRow || currentRow.deleted_at) {
    return c.json({ error: "not_found" }, 404);
  }

  // edit_log.book was backfilled in migration 0017. Legacy entries with no
  // book column (kind = 'tn'/'tq'/'twl' from before the migration) fall back
  // to (kind, row_key) only — the `el.book IS NULL` branch — so pre-migration
  // audit trails still display, just without cross-book disambiguation.
  //
  // preserve/hint/keep toggles are audited as new_version = prev_version
  // (the row's version column doesn't actually change). The history dialog
  // is a version picker, not an audit log — surfacing those entries as
  // duplicate-version rows confuses the user and triggers React key
  // collisions. Filter to actions that genuinely advance the version.
  const rs = await c.env.DB.prepare(
    `SELECT el.new_version AS version,
            el.action,
            el.created_at,
            el.payload_json,
            el.restored_from_version,
            u.id AS user_id,
            u.dcs_username AS username,
            u.dcs_full_name AS full_name
       FROM edit_log el
       LEFT JOIN users u ON u.id = el.user_id
      WHERE el.kind = ?1 AND el.row_key = ?2
        AND (el.book = ?3 OR el.book IS NULL)
        AND el.new_version IS NOT NULL
        AND el.action IN ('create', 'update', 'delete', 'restore')
      ORDER BY el.new_version ASC`,
  )
    .bind(kind, id, book)
    .all<{
      version: number;
      action: string;
      created_at: number;
      payload_json: string | null;
      restored_from_version: number | null;
      user_id: number | null;
      username: string | null;
      full_name: string | null;
    }>();

  // Bound to the latest 'create' onward: a reclaimed slot (issue #427 option
  // 1, bookReimport.ts) hosts a completely different logical row than the dead
  // tombstoned one whose (kind, book, id) it reuses — surfacing the old row's
  // entries here would let a translator "restore" unrelated content into it.
  // A no-op for every non-reclaimed row (their only create is at version 1).
  const logEntries = boundHistoryToLastCreate(rs.results ?? []);
  const fields = HISTORY_FIELDS[kind];

  // Always anchor the list with a v1 entry. If a real `create` survived
  // bounding above, use it; otherwise synthesize one from the current row.
  const hasCreate = logEntries.some((e) => e.action === "create");
  type Entry = (typeof logEntries)[number] & { synthetic?: boolean };
  const entries: Entry[] = hasCreate
    ? logEntries
    : [
        {
          version: 1,
          action: "imported",
          created_at: currentRow.updated_at,
          payload_json: JSON.stringify(
            Object.fromEntries(fields.map((f) => [f, currentRow[f] ?? null])),
          ),
          restored_from_version: null,
          user_id: null,
          username: null,
          full_name: null,
          synthetic: true,
        },
        ...logEntries.filter((e) => e.version > 1),
      ];

  const snapshot: Record<string, unknown> = {};
  const versions = entries.map((e) => {
    let payload: Record<string, unknown> = {};
    if (e.payload_json) {
      try {
        payload = JSON.parse(e.payload_json) as Record<string, unknown>;
      } catch {
        payload = {};
      }
    }
    if (e.action !== "delete") {
      for (const k of Object.keys(payload)) {
        snapshot[k] = payload[k];
      }
    }
    const trimmedSnapshot: Record<string, unknown> = {};
    for (const f of fields) {
      trimmedSnapshot[f] = snapshot[f] ?? null;
    }
    const trimmedPatch: Record<string, unknown> = {};
    for (const f of fields) {
      if (f in payload) trimmedPatch[f] = payload[f];
    }
    return {
      version: e.version,
      action: e.action,
      created_at: e.created_at,
      user: e.user_id
        ? { id: e.user_id, username: e.username, full_name: e.full_name }
        : null,
      patch: trimmedPatch,
      snapshot: trimmedSnapshot,
      synthetic: e.synthetic ?? false,
      restored_from_version: e.restored_from_version ?? null,
    };
  });

  // Drop reorder-churn from the version list. Before the write path stopped
  // versioning sort_order (see PATCH above), every drag wrote an `update`
  // entry that touched no content field — these reconstruct to a snapshot
  // identical to their predecessor and read as duplicate "versions" in the
  // dialog. An update whose trimmedPatch is empty changed only excluded fields
  // (sort_order), so hide it. Always keep non-update actions (create/imported/
  // delete/restore) and the row's current version, so the snapshot replay's
  // anchor and the dialog's "current" marker / diff target still resolve.
  const displayVersions = versions.filter(
    (v) =>
      v.action !== "update" ||
      Object.keys(v.patch).length > 0 ||
      v.version === currentRow.version,
  );

  return c.json({ versions: displayVersions });
});

// Single-row PATCH with optimistic concurrency. If-Match is mandatory and
// the version check is enforced inside the UPDATE itself — a SELECT-then-
// UPDATE pair would race between two concurrent writers, both seeing the
// same version and both committing, silently losing one user's edit.
rows.patch("/:kind/:id", requireEditor, async (c) => {
  const kind = c.req.param("kind");
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!isRowKind(kind)) return c.json({ error: "invalid_kind" }, 400);
  if (!book) return c.json({ error: "book_required" }, 400);

  const expected = parseIfMatch(c.req.header("if-match"));
  if (expected === null) {
    return c.json({ error: "if_match_required" }, 428);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }

  // restored_from_version is a metadata flag sent alongside the content
  // patch when the user picks "switch to v{N}" from the history dialog. The
  // row's DB version still climbs monotonically (needed for optimistic
  // concurrency), but this flag lets the UI display the chip as v{N}. Any
  // normal edit comes in without this flag, which clears the marker.
  let restoredFromVersion: number | null = null;
  if (body && typeof body === "object" && "restored_from_version" in body) {
    const raw = (body as Record<string, unknown>).restored_from_version;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
      restoredFromVersion = Math.floor(raw);
    }
    delete (body as Record<string, unknown>).restored_from_version;
  }

  const schema = PATCH_SCHEMA[kind];
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", details: parsed.error.format() }, 400);
  }
  const patch = parsed.data;

  let fields = Object.keys(patch);
  if (fields.length === 0) {
    return c.json({ error: "empty_patch" }, 400);
  }

  // Pull the current row once — used for the lock-scope lookup, the no-op
  // short-circuit, and to disambiguate 404 vs 409 if the UPDATE later misses.
  // Carries latest_source (see selectRowWithLatestSource) because a true
  // no-op PATCH returns this object as-is below — it must reflect the row's
  // real AI-provenance chip, not silently drop it.
  const current = (await selectRowWithLatestSource(c.env, kind, id, book)) as
    | (Record<string, unknown> & {
        version: number;
        deleted_at: number | null;
        book: string;
        chapter: number;
        restored_from_version: number | null;
      })
    | null;
  if (!current || current.deleted_at) return c.json({ error: "not_found" }, 404);

  // Enforce the OL-quote occurrence invariant at the source. Only fires when
  // this patch actually touches the quote or occurrence — a reorder, note-only
  // edit, or tag toggle must never trigger a retroactive heal (and the version
  // bump it carries). Look at the post-patch values: if the resulting quote is
  // original-language and the resulting occurrence is null/0, force it to 1 so
  // the stored row (and every export from it) satisfies the invariant. An
  // existing occurrence >= 1 — a real second-occurrence target — is untouched.
  const p = patch as Record<string, unknown>;
  const quoteField = QUOTE_FIELD[kind];
  if (quoteField in p || "occurrence" in p) {
    const effQuote = quoteField in p ? p[quoteField] : current[quoteField];
    const effOcc = "occurrence" in p ? p.occurrence : current.occurrence;
    if (typeof effQuote === "string" && hasOrigLang(effQuote) && (effOcc == null || effOcc === 0)) {
      p.occurrence = 1;
      fields = Object.keys(patch);
    }
  }

  // TWL ref_raw format guard (see twlRefGuard.ts — issue #724). A word link
  // is single-verse and same-chapter only, unlike tn/tq's legitimately
  // spanning ref_raw — so a range, an empty string, or a cross-chapter
  // reference has no valid rendering and must not be allowed to leave the
  // stored chapter/verse columns torn from what ref_raw says. Reject before
  // the ref_raw -> verse re-derivation below would silently take a range's
  // leading verse.
  if (kind === "twl" && "ref_raw" in p) {
    if (typeof p.ref_raw !== "string" || !isValidTwlRefRaw(p.ref_raw, current.chapter)) {
      return c.json(
        {
          error: "invalid_body",
          message: `twl ref_raw must be a single same-chapter verse reference like "${current.chapter}:N" (got ${JSON.stringify(p.ref_raw)}).`,
        },
        400,
      );
    }
  }

  // A ref_raw edit (retyping the REF field) must re-derive the `verse` integer
  // column — grouping and the read/export sort key run off chapter/verse, not
  // ref_raw. Without this the row renders its new ref while staying grouped
  // under its old verse (HOS 12 TQ v3xj). refParts collapses a range to its
  // leading verse ("12:11-12" -> [12, 11]), matching the import parser, so a
  // legitimate verse bridge keeps its leading verse for grouping while ref_raw
  // still carries the full range for display. Scope this to SAME-CHAPTER edits
  // only: cross-chapter moves aren't supported by the surrounding machinery
  // (the lock check, WS broadcast, and client caches below are all keyed to
  // one chapter), so never write a changed `chapter` here — a cross-chapter
  // ref just passes through untouched, exactly as before. The tn "change
  // reference" move sends `verse` explicitly; leave that authoritative.
  if (typeof p.ref_raw === "string" && !("verse" in p)) {
    const [ch, vs] = refParts(p.ref_raw);
    if (ch === current.chapter && vs !== current.verse) {
      p.verse = vs;
      fields = Object.keys(patch);
    }
  }

  // Lock check for non-tn kinds. TN edits are always allowed during a run —
  // the first PATCH on an updated_by-NULL row implicitly "keeps" it; further
  // PATCHes on already-kept rows are normal edits. tq/twl have no such
  // carve-out: any pipeline writing to this chapter overwrites them.
  if (kind !== "tn") {
    const lock = await activePipelineForChapter(c.env, current.book, current.chapter);
    if (lock) return c.json(lockedResponseBody(lock), 409);
  }

  // No-op short-circuit: if the precondition still holds and every patched
  // field already matches the stored value, return the row unchanged.
  // Identical re-saves are common — picker re-commit, AI completion echoing
  // the same content, an explicit Save click against a row whose draft was
  // just cleared — and shouldn't burn a version. The version check guards
  // against the TOCTOU window: if someone else moved the row forward, fall
  // through and let the UPDATE's version=expected predicate produce the proper
  // 409.
  //
  // The restore marker is deliberately NOT part of this test (issue #539 item
  // 3). It used to be: a "switch to v{N}" whose snapshot equalled the row's
  // current content still failed `restoreMatches` and fell through to a full
  // versioned write, so picking a version the row already held burnt a version
  // and pushed a phantom entry into the history dialog — the same restore the
  // dialog then had to hide, which is how a real human version went missing.
  // `restored_from_version` records where the row's CURRENT content came from,
  // and this branch is reached only when that content did not move, so the
  // marker still describes the row exactly as well as it did a moment ago.
  // Leaving it alone is therefore not a stale-marker bug: it is the same answer
  // to an unchanged question. (The two directions this now covers are a restore
  // arriving at content that already matches, and an ordinary no-op save on a
  // row that carries a marker — both used to bump.)
  //
  // ONE CARVE-OUT, and it is data-loss-shaped rather than cosmetic. A trashed tn
  // row is queued for the 05:30 finalize, which promotes trashed_at ->
  // deleted_at unconditionally. The full write path below applies
  // contentPatchClearClauses, which sets `trashed_at = NULL` for tn — an edit is
  // the strongest signal the row should live (see trashedRowPatch.test.mjs and
  // the incident it pins). Before this change, a trashed row carrying a restore
  // marker failed `restoreMatches` and fell through to that write even on
  // identical content, so it got revived as a side effect. Short-circuiting
  // would leave it heading for deletion instead. A saved version is not worth a
  // deleted note, so a trashed tn row keeps the pre-existing full-write path
  // even when nothing about its content moved.
  const trashedTnRow =
    kind === "tn" && (current as Record<string, unknown>).trashed_at != null;
  if (current.version === expected && !trashedTnRow) {
    const allMatch = fields.every(
      (f) => (patch as Record<string, unknown>)[f] === current[f],
    );
    if (allMatch) {
      // A re-save that changes no content still acknowledges a review flag:
      // clear it (no version bump, like a bit-toggle) so the cleanup chip
      // drops. Covers "proofreader verified the adapted quote, it was fine".
      // EXCLUDE a sort_order-only patch — a drag/reorder must not acknowledge a
      // review (that path is handled separately below and never reaches here on
      // a non-no-op). Guard the clear on version + deleted_at so a concurrent
      // edit/delete in the SELECT→UPDATE window still yields 409/404, not a
      // false 200 no-op.
      const reorderOnly = fields.length === 1 && fields[0] === "sort_order";
      if (kind === "tn" && !reorderOnly && (current as unknown as TnRow).review_kind != null) {
        const now = Math.floor(Date.now() / 1000);
        const res = await c.env.DB.prepare(
          `UPDATE tn_rows SET review_kind = NULL, review_reason = NULL, updated_at = ?1
             WHERE id = ?2 AND version = ?3 AND deleted_at IS NULL${bookClause(4)}`,
        )
          .bind(now, id, expected, book)
          .run();
        if (res.meta.changes) {
          const fresh = await selectRowWithLatestSource(c.env, kind, id, book);
          // Broadcast the cleared flag to other open tabs, mirroring the
          // reorder-only fast path below. This is a same-version bit-toggle,
          // so the client's row-cache version guard drops the event — but the
          // review chip is drawn from the separate book-lint fetch, which
          // Shell nudges on any row.upserted for the open book. See #660.
          if (fresh) {
            const row = fresh as unknown as TnRow | TqRow | TwlRow;
            c.executionCtx.waitUntil(
              broadcastChapter(c.env, row.book, row.chapter, { type: "row.upserted", kind, row }),
            );
          }
          return c.json(fresh ?? current);
        }
        // Row moved or was deleted between the SELECT and this UPDATE — surface
        // the normal concurrency response instead of a stale 200.
        const fresh = await c.env.DB.prepare(
          `SELECT * FROM tn_rows WHERE id = ?1${bookClause(2)}`,
        )
          .bind(id, book)
          .first<{ version: number; deleted_at: number | null }>();
        if (!fresh || fresh.deleted_at) return c.json({ error: "not_found" }, 404);
        logRowConflict(c, {
          kind,
          rowId: id,
          book,
          action: "patch",
          userId: currentUserId(c),
          expectedVersion: expected,
          fields,
          current: fresh,
        });
        return c.json({ error: "version_mismatch", current: fresh }, 409);
      }
      return c.json(current);
    }
  }

  // Reorder-only fast path: sort_order is positional metadata, not content. A
  // drag must not count as a new version — otherwise the row's version climbs
  // and the history dialog fills with entries that reconstruct to identical
  // content (sort_order is excluded from the snapshot), reading as duplicate
  // "versions". Apply it under the same optimistic-concurrency guard, but skip
  // the version bump AND the edit_log entry. Mirrors the preserve/hint/trash
  // bit-toggles, which are likewise non-versioning. updated_at still moves so
  // mtime views reflect the activity; updated_by stays put (standing authorship
  // is whoever wrote the note, not whoever reordered it). Only tn/twl carry
  // sort_order — a tq patch can never reach here (its schema has no field).
  if (fields.length === 1 && fields[0] === "sort_order") {
    const now = Math.floor(Date.now() / 1000);
    const res = await c.env.DB.prepare(
      `UPDATE ${KIND_TO_TABLE[kind]}
         SET sort_order = ?1, updated_at = ?2
       WHERE id = ?3 AND version = ?4 AND deleted_at IS NULL${bookClause(5)}`,
    )
      .bind((patch as Record<string, unknown>).sort_order, now, id, expected, book)
      .run();
    if (!res.meta.changes) {
      // Version moved on under us (a content edit landed first). Surface 409
      // so the outbox auto-heals against the server version and retries — the
      // same path a content-field mismatch takes.
      const fresh = await c.env.DB.prepare(
        `SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1${bookClause(2)}`,
      )
        .bind(id, book)
        .first<{ version: number; deleted_at: number | null }>();
      if (!fresh || fresh.deleted_at) return c.json({ error: "not_found" }, 404);
      logRowConflict(c, {
        kind,
        rowId: id,
        book,
        action: "patch",
        userId: currentUserId(c),
        expectedVersion: expected,
        fields,
        current: fresh,
      });
      return c.json({ error: "version_mismatch", current: fresh }, 409);
    }
    const updated = await selectRowWithLatestSource(c.env, kind, id, book);
    if (updated) {
      const row = updated as unknown as TnRow | TqRow | TwlRow;
      c.executionCtx.waitUntil(
        broadcastChapter(c.env, row.book, row.chapter, { type: "row.upserted", kind, row }),
      );
    }
    return c.json(updated);
  }

  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  const setClauses = fields.map((f, i) => `${f} = ?${i + 1}`);
  // Any TN content edit clears a pending review flag (the adapted-note verify
  // queue) and also UN-trashes the row — a versioned edit landing on a trashed
  // row must not be silently tombstoned by the 05:30 nightly finalize (see
  // contentPatchClauses.ts for the full rationale and the SQL-backed
  // regression test trashedRowPatch.test.mjs). Literal NULLs — no bind params,
  // so positional indices below are unaffected. The reorder-only fast path
  // above returns before here, so a drag never clears a flag or revives a
  // trashed note.
  setClauses.push(...contentPatchClearClauses(kind));
  if (kind === "tn") {
    // Translation-mode: a human content edit demotes an AI draft (or a
    // previously-validated row) to 'edited' — it must be re-approved before it
    // re-enters the validated-example export. Literal CASE, no bind param, so
    // positional indices are unaffected. NULL (English root / non-translation
    // rows) stays NULL, so the English workflow is untouched.
    setClauses.push(
      "translation_state = CASE WHEN translation_state IN ('ai_draft','validated') THEN 'edited' ELSE translation_state END",
    );
  }
  if (kind === "tq") {
    // Translation-mode: same demotion as tN. A human content edit demotes an AI
    // draft (or a previously-validated row) to 'edited'. tQ has no review_kind/
    // review_reason columns, so only the state CASE applies. Literal CASE, no
    // bind param; NULL (English root) stays NULL so English is untouched.
    setClauses.push(
      "translation_state = CASE WHEN translation_state IN ('ai_draft','validated') THEN 'edited' ELSE translation_state END",
    );
  }
  const baseParams = fields.length;
  // version bump and metadata go after the patch fields, then the WHERE
  // params (id + expected version + book) tail the bindings.
  setClauses.push(`version = version + 1`);
  setClauses.push(`updated_at = ?${baseParams + 1}`);
  setClauses.push(`updated_by = ?${baseParams + 2}`);
  setClauses.push(`restored_from_version = ?${baseParams + 3}`);
  const values = [
    ...fields.map((f) => (patch as Record<string, unknown>)[f]),
    now,
    userId,
    restoredFromVersion,
    id,
    expected,
    book,
  ];

  // Atomic: the audit INSERT is conditional on the UPDATE matching, so a
  // version-mismatch never leaves an orphan audit row. D1 batch() commits
  // both statements together and runs them sequentially on one connection,
  // so changes() in the second statement is the row count of THIS batch's
  // UPDATE. (An EXISTS probe on version = expected+1 is NOT equivalent: a
  // racing writer can move the row to expected+1, which would log the
  // rejected patch into history and corrupt version snapshots.)
  const newVersion = expected + 1;
  const [updateRes] = await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE ${KIND_TO_TABLE[kind]}
           SET ${setClauses.join(", ")}
         WHERE id = ?${baseParams + 4}
           AND version = ?${baseParams + 5}
           AND deleted_at IS NULL${bookClause(baseParams + 6)}`,
      )
      .bind(...values),
    c.env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, restored_from_version)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'update', ?7, ?8
         WHERE changes() > 0`,
      )
      .bind(kind, id, book, userId, expected, newVersion, JSON.stringify(patch), restoredFromVersion),
  ]);

  if (!updateRes.meta.changes) {
    // No row updated: either gone, soft-deleted, or version moved on. Fetch
    // current to distinguish 404 vs 409 for the client.
    const fresh = await c.env.DB.prepare(
      `SELECT * FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1${bookClause(2)}`,
    )
      .bind(id, book)
      .first<{ version: number; deleted_at: number | null }>();
    if (!fresh || fresh.deleted_at) return c.json({ error: "not_found" }, 404);
    logRowConflict(c, {
      kind,
      rowId: id,
      book,
      action: "patch",
      userId: currentUserId(c),
      expectedVersion: expected,
      fields,
      current: fresh,
    });
    return c.json({ error: "version_mismatch", current: fresh }, 409);
  }

  const updated = await selectRowWithLatestSource(c.env, kind, id, book);
  if (updated) {
    const row = updated as unknown as TnRow | TqRow | TwlRow;
    c.executionCtx.waitUntil(
      broadcastChapter(c.env, row.book, row.chapter, { type: "row.upserted", kind, row }),
    );
    // Edits reopen the checkoff. The reorder-only and no-op paths return
    // before here, so reaching this point means real content changed and the
    // version bumped. Best-effort and non-blocking; see reopenLaneChecks.
    const lane = KIND_TO_REOPEN_LANE[kind];
    if (lane) {
      // Reopen the lane on every verse the note covers NOW and every verse it
      // covered BEFORE this edit — a narrowed span ("1:2-3" → "1:2") or a verse
      // move must clear the lane on verses it no longer renders under, not just
      // the ones it lands on. `current` is the pre-edit row. Singletons → one.
      const verses = new Set<number>([
        ...coveredVersesFromRef(row.ref_raw, row.verse),
        ...coveredVersesFromRef(current.ref_raw as string | null, current.verse as number),
      ]);
      c.executionCtx.waitUntil(
        Promise.all(
          [...verses].map((v) => reopenLaneChecks(c.env, row.book, row.chapter, v, [lane])),
        ),
      );
    }
  }
  return c.json(updated);
});

// Soft delete with the same atomic version guard as PATCH.
rows.delete("/:kind/:id", requireEditor, async (c) => {
  const kind = c.req.param("kind");
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!isRowKind(kind)) return c.json({ error: "invalid_kind" }, 400);
  if (!book) return c.json({ error: "book_required" }, 400);
  const expected = parseIfMatch(c.req.header("if-match"));
  if (expected === null) {
    return c.json({ error: "if_match_required" }, 428);
  }

  // Lock check applies to all kinds on delete — no carve-out for tn here.
  // The auto-apply step is responsible for removing un-kept TNs; manual
  // deletion mid-run would race with it.
  const scope = await c.env.DB.prepare(
    `SELECT book, chapter, verse, ref_raw FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1${bookClause(2)}`,
  )
    .bind(id, book)
    .first<{ book: string; chapter: number; verse: number; ref_raw: string | null }>();
  if (scope) {
    const lock = await activePipelineForChapter(c.env, scope.book, scope.chapter);
    if (lock) return c.json(lockedResponseBody(lock), 409);
  }

  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  const newVersion = expected + 1;
  const [updateRes] = await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE ${KIND_TO_TABLE[kind]}
           SET deleted_at = ?1, version = version + 1, updated_at = ?1, updated_by = ?2
         WHERE id = ?3 AND version = ?4 AND deleted_at IS NULL${bookClause(5)}`,
      )
      .bind(now, userId, id, expected, book),
    c.env.DB
      .prepare(
        // changes()-gated like PATCH: the audit lands only when THIS batch's
        // UPDATE soft-deleted the row, not when a racing writer matched the
        // probed end state.
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'delete'
         WHERE changes() > 0`,
      )
      .bind(kind, id, book, userId, expected, newVersion),
  ]);

  if (!updateRes.meta.changes) {
    const fresh = await c.env.DB.prepare(
      `SELECT version, deleted_at FROM ${KIND_TO_TABLE[kind]} WHERE id = ?1${bookClause(2)}`,
    )
      .bind(id, book)
      .first<{ version: number; deleted_at: number | null }>();
    if (!fresh || fresh.deleted_at) return c.json({ error: "not_found" }, 404);
    logRowConflict(c, {
      kind,
      rowId: id,
      book,
      action: "delete",
      userId: currentUserId(c),
      expectedVersion: expected,
      fields: [],
      current: fresh,
    });
    return c.json({ error: "version_mismatch", current: fresh }, 409);
  }
  if (scope) {
    c.executionCtx.waitUntil(
      broadcastChapter(c.env, scope.book, scope.chapter, {
        type: "row.deleted",
        kind,
        id,
        version: newVersion,
      }),
    );
    // Edits reopen the checkoff: a successful delete (reached only after the
    // changes()-gated soft-delete above landed) reopens the row's lane.
    // Best-effort and non-blocking; see reopenLaneChecks.
    const lane = KIND_TO_REOPEN_LANE[kind];
    if (lane) {
      // Reopen on every verse the deleted note covered, matching where it
      // rendered (a bridged "1:2-3" was checkable on verses 2 and 3).
      const verses = coveredVersesFromRef(scope.ref_raw, scope.verse);
      c.executionCtx.waitUntil(
        Promise.all(verses.map((v) => reopenLaneChecks(c.env, scope.book, scope.chapter, v, [lane]))),
      );
    }
  }
  return c.json({ ok: true });
});

// Shared body shape for /preserve and /hint. Both toggle a bit on tn_rows
// and append an audit row; neither touches `updated_by` (these are intent
// signals, not content edits) or `version` (collisions on these bits are
// idempotent in practice). Lock-exempt for the same reason the legacy
// /keep was — the translator must be able to claim/release a row mid-run.
const TnBitBody = z.object({ value: z.union([z.literal(0), z.literal(1), z.boolean()]) });

async function setTnBit(
  env: Env,
  id: string,
  book: string,
  userId: number | null,
  column: "preserve" | "hint",
  value: 0 | 1,
): Promise<TnRow | null> {
  const now = Math.floor(Date.now() / 1000);
  const action = value === 1 ? column : `un${column}`;
  const [updateRes] = await env.DB.batch([
    env.DB
      .prepare(
        // updated_at moves so the row sorts to "recently touched" in any
        // mtime-based view, but updated_by stays NULL — standing authorship
        // is whoever wrote the note content, not whoever toggled the bit.
        `UPDATE tn_rows
           SET ${column} = ?1, updated_at = ?2
         WHERE id = ?3 AND deleted_at IS NULL${bookClause(4)}`,
      )
      .bind(value, now, id, book),
    env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action)
         SELECT 'tn', ?1, book, ?2, version, version, ?3
           FROM tn_rows
          WHERE id = ?1 AND deleted_at IS NULL${bookClause(4)}`,
      )
      .bind(id, userId ?? null, action, book),
  ]);
  if (!updateRes.meta.changes) return null;
  return env.DB.prepare(`SELECT * FROM tn_rows WHERE id = ?1${bookClause(2)}`).bind(id, book).first<TnRow>();
}

function coerceBitValue(raw: 0 | 1 | boolean): 0 | 1 {
  return raw === true || raw === 1 ? 1 : 0;
}

// Set the translation_state on a target-language tN row (multilingual review
// flow; PIPELINE-SPEC §4.1). Like setTnBit, this is a state flip, not a
// content edit: it does NOT bump `version` (in-flight If-Match preconditions
// stay valid) and leaves `updated_by` alone. The audit action ('validate' |
// 'unvalidate') is written with source=NULL — an explicit human approval is a
// human edit_log entry, which is also what clears the 'ai_pipeline' chip. The
// nightly context-repo export selects on translation_state='validated'.
async function setTnTranslationState(
  env: Env,
  id: string,
  book: string,
  userId: number | null,
  state: "validated" | "edited" | null,
): Promise<TnRow | null> {
  const now = Math.floor(Date.now() / 1000);
  const action = state === "validated" ? "validate" : "unvalidate";
  // Approval snapshots the now-published content into pre_draft_json (migration
  // 0049) — NOT NULL. A subsequent human content edit demotes 'validated' ->
  // 'edited' (see the demote CASE in the PATCH handler), and the export gate
  // then ships this snapshot (the last validated content) until the edit is
  // re-approved. Clearing to NULL instead would let the unvalidated edit reach
  // DCS as a legacy row. Un-approve leaves the snapshot in place (the once-
  // approved content keeps exporting — accepted, docs/plan Design 2).
  const snapshotClause = state === "validated"
    ? ", pre_draft_json = json_object('note', note, 'tags', tags)"
    : "";
  // Only rows that are ALREADY translation drafts (state non-NULL) can be
  // validated/un-validated. Without this guard a validate on a row the
  // translate pipeline never touched (translation_state IS NULL — e.g. a
  // pre-state-machine imported row) would stamp 'validated' and the nightly
  // context-repo export would then ship it as a validated few-shot example
  // even though it was never a reviewed AI draft. The audit INSERT carries the
  // same guard so no edit_log entry is written when nothing changed.
  const [updateRes] = await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE tn_rows
           SET translation_state = ?1, updated_at = ?2${snapshotClause}
         WHERE id = ?3 AND deleted_at IS NULL AND translation_state IS NOT NULL${bookClause(4)}`,
      )
      .bind(state, now, id, book),
    env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action)
         SELECT 'tn', ?1, book, ?2, version, version, ?3
           FROM tn_rows
          WHERE id = ?1 AND deleted_at IS NULL AND translation_state IS NOT NULL${bookClause(4)}`,
      )
      .bind(id, userId ?? null, action, book),
  ]);
  if (!updateRes.meta.changes) return null;
  return env.DB.prepare(`SELECT * FROM tn_rows WHERE id = ?1${bookClause(2)}`).bind(id, book).first<TnRow>();
}

// Set the translation_state on a target-language tQ row — the exact analogue of
// setTnTranslationState (kind='tq'). State flip, not a content edit: does NOT
// bump `version` and leaves `updated_by` alone; audit source=NULL (human
// approval, which also clears the 'ai_pipeline' chip). Guarded on
// translation_state IS NOT NULL so a row the translate pipeline never touched
// can't be validated.
async function setTqTranslationState(
  env: Env,
  id: string,
  book: string,
  userId: number | null,
  state: "validated" | "edited" | null,
): Promise<TqRow | null> {
  const now = Math.floor(Date.now() / 1000);
  const action = state === "validated" ? "validate" : "unvalidate";
  // Approval snapshots the now-published content — see setTnTranslationState.
  const snapshotClause = state === "validated"
    ? ", pre_draft_json = json_object('question', question, 'response', response)"
    : "";
  const [updateRes] = await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE tq_rows
           SET translation_state = ?1, updated_at = ?2${snapshotClause}
         WHERE id = ?3 AND deleted_at IS NULL AND translation_state IS NOT NULL${bookClause(4)}`,
      )
      .bind(state, now, id, book),
    env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action)
         SELECT 'tq', ?1, book, ?2, version, version, ?3
           FROM tq_rows
          WHERE id = ?1 AND deleted_at IS NULL AND translation_state IS NOT NULL${bookClause(4)}`,
      )
      .bind(id, userId ?? null, action, book),
  ]);
  if (!updateRes.meta.changes) return null;
  return env.DB.prepare(`SELECT * FROM tq_rows WHERE id = ?1${bookClause(2)}`).bind(id, book).first<TqRow>();
}

// Flip the visible "trash" state on a tn row. Like setTnBit (preserve/hint),
// this does NOT bump `version` — it's a reversible state flip, not a content
// edit — so in-flight If-Match preconditions on the same row stay valid and no
// 409 friction is introduced. `trashed_at` is distinct from `deleted_at`: a
// trashed row stays visible (grayed, sorted last) and restorable until the
// nightly job promotes it to a deleted_at tombstone. updated_by is left alone
// (standing authorship is whoever wrote the note content). The audit action is
// 'trash'/'untrash' — deliberately NOT in the history version filter, so these
// flips don't surface as duplicate-version rows in the history dialog.
async function setTnTrashed(
  env: Env,
  id: string,
  book: string,
  userId: number | null,
  trashed: boolean,
): Promise<TnRow | null> {
  const now = Math.floor(Date.now() / 1000);
  const action = trashed ? "trash" : "untrash";
  const [updateRes] = await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE tn_rows
           SET trashed_at = ?1, updated_at = ?2
         WHERE id = ?3 AND deleted_at IS NULL${bookClause(4)}`,
      )
      .bind(trashed ? now : null, now, id, book),
    env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action)
         SELECT 'tn', ?1, book, ?2, version, version, ?3
           FROM tn_rows
          WHERE id = ?1 AND deleted_at IS NULL${bookClause(4)}`,
      )
      .bind(id, userId ?? null, action, book),
  ]);
  if (!updateRes.meta.changes) return null;
  return env.DB.prepare(`SELECT * FROM tn_rows WHERE id = ?1${bookClause(2)}`).bind(id, book).first<TnRow>();
}

// POST /api/rows/tn/:id/preserve — toggle the "survive future AI pipeline
// sweeps" bit. Body: { value: 0 | 1 | boolean }. Lock-exempt. Idempotent.
rows.post("/tn/:id/preserve", requireEditor, async (c) => {
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!book) return c.json({ error: "book_required" }, 400);
  const userId = currentUserId(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = TnBitBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  }
  const updated = await setTnBit(c.env, id, book, userId, "preserve", coerceBitValue(parsed.data.value));
  if (!updated) return c.json({ error: "not_found" }, 404);
  c.executionCtx.waitUntil(
    broadcastChapter(c.env, updated.book, updated.chapter, { type: "row.upserted", kind: "tn", row: updated }),
  );
  return c.json(updated);
});

// POST /api/rows/tn/:id/hint — toggle the "queue as AI-pipeline hint" bit.
// hint=1 rows are sent into the next /api/pipelines/start as options.hints
// and are excluded from deleteUnkeptTns; AI expansion clears the bit.
rows.post("/tn/:id/hint", requireEditor, async (c) => {
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!book) return c.json({ error: "book_required" }, 400);
  const userId = currentUserId(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = TnBitBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  }
  const value = coerceBitValue(parsed.data.value);
  // A hint with no note gives bp-assistant's tn-writer no framing to expand
  // from — the hint's `seed` is this row's note, and an empty quote + empty
  // seed has neither a source phrase nor any guidance (a path that has never
  // run end-to-end). Require note text before a row can be queued as a hint.
  if (value === 1) {
    const row = await c.env.DB.prepare(
      `SELECT note FROM tn_rows WHERE id = ?1 AND deleted_at IS NULL${bookClause(2)}`,
    )
      .bind(id, book)
      .first<{ note: string | null }>();
    if (!row) return c.json({ error: "not_found" }, 404);
    if (!row.note || !row.note.trim()) {
      return c.json(
        { error: "note_required", message: "Add note text before queuing this row as an AI hint." },
        400,
      );
    }
  }
  const updated = await setTnBit(c.env, id, book, userId, "hint", value);
  if (!updated) return c.json({ error: "not_found" }, 404);
  c.executionCtx.waitUntil(
    broadcastChapter(c.env, updated.book, updated.chapter, { type: "row.upserted", kind: "tn", row: updated }),
  );
  return c.json(updated);
});

// POST /api/rows/tn/:id/validate — the translation-mode "Approve" action.
// Body: { value: 0 | 1 | boolean } (1 → validated, 0 → back to edited).
// Lock-exempt, non-version-bumping, idempotent — mirrors /preserve. Marks a
// reviewed AI draft as human-approved so the nightly context export can turn
// it into a validated few-shot example (PIPELINE-SPEC §4.2).
rows.post("/tn/:id/validate", requireEditor, async (c) => {
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!book) return c.json({ error: "book_required" }, 400);
  const userId = currentUserId(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = TnBitBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  }
  // value=1 → validated; value=0 → 'edited' (un-approve keeps it in the
  // reviewed-but-not-validated state rather than pretending it's a fresh draft).
  const nextState = coerceBitValue(parsed.data.value) === 1 ? "validated" : "edited";
  const updated = await setTnTranslationState(c.env, id, book, userId, nextState);
  if (!updated) return c.json({ error: "not_found" }, 404);
  c.executionCtx.waitUntil(
    broadcastChapter(c.env, updated.book, updated.chapter, { type: "row.upserted", kind: "tn", row: updated }),
  );
  return c.json(updated);
});

// POST /api/rows/tq/:id/validate — the translationQuestions "Approve" action,
// the exact analogue of /tn/:id/validate. Body: { value: 0 | 1 | boolean }
// (1 → validated, 0 → back to edited). Lock-exempt, non-version-bumping.
rows.post("/tq/:id/validate", requireEditor, async (c) => {
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!book) return c.json({ error: "book_required" }, 400);
  const userId = currentUserId(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = TnBitBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  }
  const nextState = coerceBitValue(parsed.data.value) === 1 ? "validated" : "edited";
  const updated = await setTqTranslationState(c.env, id, book, userId, nextState);
  if (!updated) return c.json({ error: "not_found" }, 404);
  c.executionCtx.waitUntil(
    broadcastChapter(c.env, updated.book, updated.chapter, { type: "row.upserted", kind: "tq", row: updated }),
  );
  return c.json(updated);
});

// POST /api/rows/tn/:id/keep — legacy alias for /preserve with value=1.
// The old semantics ("claim a row during a run by setting updated_by") are
// folded into the always-on preserve bit. Kept so external callers and
// in-flight outbox ops keep working without a coordinated migration.
rows.post("/tn/:id/keep", requireEditor, async (c) => {
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!book) return c.json({ error: "book_required" }, 400);
  const userId = currentUserId(c);
  const updated = await setTnBit(c.env, id, book, userId, "preserve", 1);
  if (!updated) return c.json({ error: "not_found" }, 404);
  c.executionCtx.waitUntil(
    broadcastChapter(c.env, updated.book, updated.chapter, { type: "row.upserted", kind: "tn", row: updated }),
  );
  return c.json(updated);
});

// POST /api/rows/tn/:id/trash — the note delete button. Moves the note to the
// visible "trash" state: the card grays out, drops to the bottom of the verse,
// and gains a Restore button. Reversible via /restore; finalized to a
// permanent deleted_at tombstone by the nightly 06:00 UTC job. Lock-exempt and
// non-version-bumping, like /preserve. No If-Match — idempotent state flip.
rows.post("/tn/:id/trash", requireEditor, async (c) => {
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!book) return c.json({ error: "book_required" }, 400);
  const userId = currentUserId(c);
  const updated = await setTnTrashed(c.env, id, book, userId, true);
  if (!updated) return c.json({ error: "not_found" }, 404);
  c.executionCtx.waitUntil(
    broadcastChapter(c.env, updated.book, updated.chapter, { type: "row.upserted", kind: "tn", row: updated }),
  );
  return c.json(updated);
});

// POST /api/rows/tn/:id/restore — bring a trashed note back to the live set.
rows.post("/tn/:id/restore", requireEditor, async (c) => {
  const id = c.req.param("id");
  const book = c.req.query("book");
  if (!book) return c.json({ error: "book_required" }, 400);
  const userId = currentUserId(c);
  const updated = await setTnTrashed(c.env, id, book, userId, false);
  if (!updated) return c.json({ error: "not_found" }, 404);
  c.executionCtx.waitUntil(
    broadcastChapter(c.env, updated.book, updated.chapter, { type: "row.upserted", kind: "tn", row: updated }),
  );
  return c.json(updated);
});
