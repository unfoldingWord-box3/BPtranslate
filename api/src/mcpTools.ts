// Tools for the chat MCP endpoint (mcp.ts). Phase 1 of the "Book packages via
// chat" plan: a reviewer in BT Servant can see what a book still needs, read
// the notes for a verse range, and link the chat to their BPtranslate account
// (chatLinks.ts). Every tool but bpt_link_account takes the session_token,
// because the link decides which workspace is read (issue #676). Reads go
// through readerFrom; writes (bpt_edit_row, bpt_approve: issue #670 part a;
// bpt_bulk_set_state: part c) go through principalFrom, so every write carries
// a real editor, and run the same PATCH / validate routes the web app uses, as
// that user, pinned to the version the reviewer was shown. bpt_draft (part b)
// starts an AI draft through the web app's POST /api/pipelines/start, for
// admins only, and bpt_job_status reads it back. The template tools
// (bpt_templates_for_row, bpt_edit_template, bpt_approve_template) do the same
// for note templates, and bpt_get_article, bpt_edit_article and
// bpt_approve_article (part d) for tW/tA article parts; their reads go through
// send("GET") as the linked user, because the template and article routes are
// editor-only and getJson carries no user. bpt_get_preferences and
// bpt_edit_preferences (#784) read and change the project's translation
// preferences; the edit is admin-only and writes through sendAsAdmin.
//
// Each tool reads through the SAME route handlers the web app uses (`getJson`
// runs the Hono app in-process), so chat and web never disagree about counts
// or which rows are live. Two deliberate exceptions: (1) the article and
// template counts in bpt_package_status come from session.packageRefs, a
// read-only D1 query (packageRefs.ts), because those list routes are
// editor-only and the in-process call carries no user; (2) the en_note of
// bpt_chunk_work and bpt_get_row comes from session.sourceNotes (sourceNotes.ts), an anonymous
// Door43 read of the same English tN file the web app's browser fetches.
// Tool names carry the bpt_ prefix because BT Servant
// pools every registered server's tools into one namespace.

export interface McpWorkspace {
  slug: string;
  label: string;
  org: string;
}

// One linked user in the workspace their link names.
export interface McpSession {
  workspace: McpWorkspace;
  principal: ChatPrincipal;
  // GET a path on this Worker's own API, in-process, against the session's
  // workspace env. Returns the parsed JSON body and the HTTP status.
  getJson: (path: string) => Promise<{ status: number; body: unknown }>;
  // Send a write to this Worker's own API, in-process, as this session's user
  // (auth.ts chatWriteEnv), with If-Match when given. Same return shape. A
  // body of undefined sends no body and no Content-Type (a read as the user).
  send: (method: string, path: string, body?: unknown, ifMatch?: number) => Promise<{ status: number; body: unknown }>;
  // The one read that does NOT go through a route handler: the tW/tA articles
  // and note templates a book references, read straight from the workspace's
  // D1 (packageRefs.ts says why). Read-only rows; the tool sends counts only.
  packageRefs: (book: string) => Promise<PackageRefRows>;
  // The published English tN for one chapter of a book, keyed by row id, read
  // on Door43 from the source that chapter's notes came from: a per-book or
  // per-chapter override, else the project's translationSource (sourceNotes.ts).
  // Never throws.
  sourceNotes: (book: string, chapter: number) => Promise<SourceNotes>;
  // HMAC of a bpt_bulk_set_state confirm token body under a server secret
  // (auth.ts chatConfirmMac); null when the secret is not configured.
  confirmMac: (data: string) => Promise<string | null>;
  // The linked user's real role in this workspace is admin (chatLinks.ts
  // chatIsAdmin). principal.role is capped at editor; bpt_draft asks this.
  isAdmin: () => Promise<boolean>;
  // send() with the user's real admin role instead of the editor cap, for a
  // route that is admin-only in the web app too (bpt_edit_preferences). It
  // re-reads the role and answers 403 not_an_admin without calling the route
  // when the user is not an admin.
  sendAsAdmin: (method: string, path: string, body?: unknown, ifMatch?: number) => Promise<{ status: number; body: unknown }>;
  // Per-kind counts of what a pipeline job's apply staged, applied and
  // rejected (pipelines.ts jobResultCounts): a second read that skips the
  // route handlers, like packageRefs. bpt_job_status calls it only after the
  // job route answered for the caller's own job.
  jobResults: (jobId: string) => Promise<Record<string, { proposed: number; applied: number; rejected: number }>>;
}

export type LinkClaim =
  | { ok: true; token: string; expiresAt: number; workspace: McpWorkspace; principal: ChatPrincipal }
  | { ok: false };

export interface ToolContext {
  session: (token: string) => Promise<McpSession | null>;
  claimLink: (code: string) => Promise<LinkClaim>;
}

import type { ChatPrincipal } from "./chatLinks.ts";
import { isTsMilestone } from "./tsMilestone.ts";
import { articleIdForTa, articleIdForTw, parseTaRef, parseTwRef, taPaths, twPath } from "./articlePopulate.ts";
import { shortSupport, summarizePackageRefs, type PackageRefRows } from "./packageRefs.ts";
import type { SourceNotes } from "./sourceNotes.ts";
import { isTranslationConfig } from "./workflowLayouts.ts";
import type { ProjectConfig } from "./projectConfig.ts";
import { REGISTERS } from "./translationMemoryLib.ts";

export class ToolInputError extends Error {}

const NOT_LINKED =
  "This chat is not linked to a BPtranslate account, or the link expired or was revoked. " +
  "In the BPtranslate web app, open the account menu, choose Link chat assistant, and send the code here.";

// Who a read acts as, and so which workspace it reads: any live link, viewer
// or editor. The token is a secret the user's own memory holds; it is never
// echoed back, not even in an error.
export async function readerFrom(args: Record<string, unknown>, ctx: ToolContext): Promise<McpSession> {
  const token = args.session_token;
  if (typeof token !== "string" || !token) throw new ToolInputError(NOT_LINKED);
  const session = await ctx.session(token);
  if (!session) throw new ToolInputError(NOT_LINKED);
  return session;
}

// Who a write acts as: the one entry point for tools that change anything.
// Refuses anyone who is not an editor in the link's workspace right now (chat
// caps admins at editor), so a write tool cannot forget the role check.
export async function principalFrom(args: Record<string, unknown>, ctx: ToolContext): Promise<McpSession> {
  const session = await readerFrom(args, ctx);
  if (session.principal.role !== "editor") {
    throw new ToolInputError(
      `${session.principal.username} cannot edit in this project. Ask a project admin to add them to the Door43 team.`,
    );
  }
  return session;
}

const SESSION_TOKEN_SCHEMA = {
  type: "string",
  description:
    "The session token bpt_link_account returned for this user. It decides which language project is read. Secret: never show it in a message.",
};

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

// BT Servant caps a tool result at 32 KB (bytes, and Arabic text is two bytes
// a character) and drops what is over. Paged tools stop adding rows at this
// UTF-8 budget and hand back a cursor instead, so a long chapter is never cut
// off silently. One note's text is capped too, so a single huge row cannot
// blow the page on its own; bpt_get_row returns it whole.
export const PAGE_BYTE_BUDGET = 24_000;
export const ROW_TEXT_CAP = 6_000;
// bpt_get_row returns one row, uncapped, so it has the whole budget to itself.
// Unlike a page, it is measured as it travels (getRowBytes): mcp.ts puts
// JSON.stringify(result) into content[0].text and then JSON-encodes the
// envelope again, so every quote and backslash costs double on the wire. The
// 2,000 bytes under the 32 KB cap cover the rest of the envelope.
export const GET_ROW_BYTE_BUDGET = 30_000;
const utf8 = new TextEncoder();
export const byteLength = (v: unknown) => utf8.encode(JSON.stringify(v)).length;
export const MAX_PAGE_ROWS = 25;
const DEFAULT_PAGE_ROWS = 10;

const BOOK_RE = /^[A-Z1-3][A-Z]{2}$/;

function bookArg(args: Record<string, unknown>): string {
  const raw = args.book;
  if (typeof raw !== "string") throw new ToolInputError("book is required, as a 3-letter code like TIT");
  const book = raw.trim().toUpperCase();
  if (!BOOK_RE.test(book)) throw new ToolInputError(`book must be a 3-letter code like TIT, got "${raw}"`);
  return book;
}

function intArg(args: Record<string, unknown>, key: string, opts: { min: number; required?: boolean }): number | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    if (opts.required) throw new ToolInputError(`${key} is required`);
    return undefined;
  }
  const n = typeof raw === "string" && /^\d{1,6}$/.test(raw.trim()) ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < opts.min || n > 999_999) {
    throw new ToolInputError(`${key} must be a whole number >= ${opts.min}`);
  }
  return n;
}

async function apiGet(session: McpSession, path: string): Promise<Record<string, unknown>> {
  const { status, body } = await session.getJson(path);
  if (status === 404) throw new ToolInputError(`not found: ${path}`);
  if (status !== 200) throw new Error(`BPtranslate API ${path} returned ${status}`);
  return body as Record<string, unknown>;
}

interface ChapterSummary {
  chapter: number;
  verses: number;
  tn: number;
  tq: number;
  twl: number;
  tnValidated: number;
  tqValidated: number;
  versesDone: number;
}

const whoami: ToolDef = {
  name: "bpt_whoami",
  description:
    "Which BPtranslate language project this user's session token reads, which user it acts as, and whether they can edit. Call once at the start of a conversation.",
  inputSchema: {
    type: "object",
    properties: { session_token: SESSION_TOKEN_SCHEMA },
    required: ["session_token"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const { workspace, principal: p } = await readerFrom(args, ctx);
    return { workspace, linked_user: p.username, role: p.role, access: p.role === "editor" ? "edit" : "read_only" };
  },
};

const linkAccount: ToolDef = {
  name: "bpt_link_account",
  description:
    "Link this chat user to their BPtranslate account with the one-time code from the web app (account menu, Link chat assistant). The code belongs to one language project. Returns a session_token for that project: save it in this user's memory next to that project (a user may link several projects, one token each), pass it to every other bpt_ tool for that project, and never show it in a message. Only in a one-to-one chat, never in a group.",
  inputSchema: {
    type: "object",
    properties: { code: { type: "string", description: "The 8-character code, e.g. ABCD-EFGH" } },
    required: ["code"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    if (typeof args.code !== "string") throw new ToolInputError("code is required");
    const r = await ctx.claimLink(args.code);
    if (!r.ok) {
      throw new ToolInputError(
        "That code did not work. Codes work once and expire after 10 minutes. Get a new one from the web app.",
      );
    }
    return {
      linked_user: r.principal.username,
      role: r.principal.role,
      access: r.principal.role === "editor" ? "edit" : "read_only",
      workspace: r.workspace,
      session_token: r.token,
      expires_at: new Date(r.expiresAt * 1000).toISOString(),
      note: "Save session_token in this user's memory now. Never show it in a message.",
    };
  },
};

const listBooks: ToolDef = {
  name: "bpt_list_books",
  description: "Books imported into this user's language project, as 3-letter codes.",
  inputSchema: {
    type: "object",
    properties: { session_token: SESSION_TOKEN_SCHEMA },
    required: ["session_token"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const body = await apiGet(await readerFrom(args, ctx), "/api/books");
    const books = (body.books as { book: string }[] | undefined) ?? [];
    return { total: books.length, books: books.map((b) => b.book) };
  },
};

const packageStatus: ToolDef = {
  name: "bpt_package_status",
  description:
    "What a book still needs: per chapter, how many translation notes (tN) and translation questions (tQ) exist and how many are approved, and how many verses are marked done. Also, for the whole book, the translationWords (tW) articles its word links (TWL) point to or its notes link in their text, the translationAcademy (tA) articles its notes cite (support reference or a link in the note text), and the note templates for the support references its notes use, each counted by state (not_started, ai_draft, edited, validated). An article counted as referenced but not loaded has not been fetched into the project yet. Use before suggesting where to start.",
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      book: { type: "string", description: "3-letter book code, e.g. TIT" },
    },
    required: ["session_token", "book"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const session = await readerFrom(args, ctx);
    const book = bookArg(args);
    const body = await apiGet(session, `/api/chapters/${book}`);
    const chapters = (body.chapters as ChapterSummary[] | undefined) ?? [];
    if (chapters.every((c) => c.verses + c.tn + c.tq === 0)) {
      throw new ToolInputError(`${book} is not imported in this project. Call bpt_list_books.`);
    }
    const totals = { tn: 0, tnApproved: 0, tq: 0, tqApproved: 0, verses: 0, versesDone: 0 };
    const rows = chapters.map((c) => {
      totals.tn += c.tn;
      totals.tnApproved += c.tnValidated;
      totals.tq += c.tq;
      totals.tqApproved += c.tqValidated;
      totals.verses += c.verses;
      totals.versesDone += c.versesDone;
      return {
        chapter: c.chapter,
        verses: c.verses,
        versesDone: c.versesDone,
        tn: c.tn,
        tnApproved: c.tnValidated,
        tq: c.tq,
        tqApproved: c.tqValidated,
      };
    });
    // The reference counts are extra: if they cannot be read, the chapter
    // counts still go back, with a note instead of the counts.
    let references: ReturnType<typeof summarizePackageRefs> | null = null;
    let referencesNote: string | undefined;
    try {
      const refs = await session.packageRefs(book);
      if (refs.translation) references = summarizePackageRefs(refs);
      else {
        referencesNote =
          "This project writes its notes in English (authoring mode), so tW/tA articles and note templates are not translated here.";
      }
    } catch (e) {
      console.error("bpt_package_status: reading article/template counts failed", e instanceof Error ? (e.stack ?? e.message) : String(e));
      referencesNote = "The tW/tA article and note template counts could not be read just now; the chapter counts above are complete.";
    }
    return {
      book,
      totals,
      chapters: rows,
      references,
      ...(referencesNote ? { references_note: referencesNote } : {}),
    };
  },
};

// The fields a reviewer needs to judge a row. Everything else on the row
// (sort order, hashes, draft metadata) stays server-side.
function capText(v: unknown, cap: number | undefined): { text: string; cut: boolean } {
  const text = typeof v === "string" ? v : "";
  return cap !== undefined && text.length > cap ? { text: text.slice(0, cap), cut: true } : { text, cut: false };
}

function projectRow(kind: "tn" | "tq", r: Record<string, unknown>, cap?: number) {
  const common = {
    id: r.id,
    ref: `${r.book} ${r.ref_raw ?? `${r.chapter}:${r.verse}`}`,
    verse: r.verse,
    quote: r.quote ?? null,
    occurrence: r.occurrence ?? null,
    state: r.translation_state ?? null,
    version: r.version,
    last_edit_source: r.latest_source ?? null,
    trashed: r.trashed_at ? true : undefined,
  };
  if (kind === "tn") {
    const note = capText(r.note, cap);
    const sr = typeof r.support_reference === "string" && r.support_reference.trim() ? r.support_reference : null;
    return {
      ...common,
      support_reference: r.support_reference ?? null,
      ta: sr ? shortSupport(sr) : null,
      note: note.text,
      truncated: note.cut || undefined,
    };
  }
  const q = capText(r.question, cap);
  const a = capText(r.response, cap);
  return { ...common, question: q.text, response: a.text, truncated: q.cut || a.cut || undefined };
}

// The first row of a page is always admitted (so the cursor moves), so one row
// must fit the budget on its own: a 6,000-character note in a 3-byte script
// plus a 6,000-character English note, after JSON escaping, can pass BT
// Servant's 32 KB cap. Shorten en_note (never the row's own note) to the
// longest prefix that keeps the object within `budget` bytes as `measure`
// counts them, or drop it to null; either way en_truncated. bpt_get_row uses
// it on its whole result, measured on the wire.
function fitEnNote(
  row: Record<string, unknown>,
  budget: number,
  measure: (v: unknown) => number = byteLength,
): Record<string, unknown> {
  const en = row.en_note;
  if (typeof en !== "string" || measure(row) <= budget) return row;
  const withLen = (n: number) => {
    let text = en.slice(0, n);
    // Do not end on half of a surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    return { ...row, en_note: text, en_truncated: true };
  };
  if (measure(withLen(0)) > budget) return { ...row, en_note: null, en_truncated: true };
  let lo = 0;
  let hi = en.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(withLen(mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return withLen(lo);
}

// Keyset cursor: the sort key of the last row returned, in the order
// chapters.ts serves rows (verse, sort_order NULLS LAST, id). A row trashed,
// deleted or added before the cursor between pages cannot shift the next page
// the way an array offset would.
type SortKey = [number, number | null, string];
const sortKey = (r: Record<string, unknown>): SortKey => [
  Number(r.verse),
  typeof r.sort_order === "number" ? r.sort_order : null,
  String(r.id),
];
function afterKey(a: SortKey, b: SortKey): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) {
    if (a[1] === null) return true;
    if (b[1] === null) return false;
    return a[1] > b[1];
  }
  return a[2] > b[2];
}
function parseCursor(raw: unknown): SortKey | null {
  if (raw === undefined || raw === null || raw === "") return null;
  try {
    const k = JSON.parse(String(raw)) as unknown;
    if (
      Array.isArray(k) && k.length === 3 && Number.isInteger(k[0]) &&
      (k[1] === null || typeof k[1] === "number") && typeof k[2] === "string"
    ) {
      return k as SortKey;
    }
  } catch {
    // fall through
  }
  throw new ToolInputError("cursor is not one this tool returned");
}

const chunkWork: ToolDef = {
  name: "bpt_chunk_work",
  description:
    "The translation notes (kind tn) or questions (kind tq) for a verse range in one chapter, with each row's id, current text, state (ai_draft, validated, ...) and version. Each tn row also has en_note: the published English note it was translated from, for comparison (null when the English source has no note with that id or could not be read; the top-level note says why). Results are paged: if next_cursor is not null, call again with it to get the rest. Never claim a chunk is complete until next_cursor is null. Each tn row's ta is the short tA article name of its support_reference (e.g. figs-metaphor). To find the notes for one figure of speech or tA article, pass support_reference (e.g. \"figs-metonymy\", \"metonymy\" or the full rc:// link) instead of reading every page; total and paging then count only the matching notes. A row marked truncated has long text cut; read it whole with bpt_get_row. en_truncated means the English note was cut, or left out (null) to keep the page under the size limit; bpt_get_row returns as much of it as fits in one response, and sets en_truncated again if it still had to cut.",
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      book: { type: "string", description: "3-letter book code, e.g. TIT" },
      chapter: { type: "integer", minimum: 0 },
      kind: { type: "string", enum: ["tn", "tq"] },
      verse_start: { type: "integer", minimum: 0, description: "First verse; omit for the whole chapter" },
      verse_end: { type: "integer", minimum: 0, description: "Last verse, inclusive" },
      include_trashed: { type: "boolean", description: "Include notes a reviewer trashed (default false)" },
      support_reference: {
        type: "string",
        description: 'tn only: return just the notes for this tA article, e.g. "figs-metaphor", "metaphor" or "rc://*/ta/man/translate/figs-metaphor" (case-insensitive)',
      },
      cursor: { type: "string", description: "next_cursor from the previous page" },
      limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_ROWS },
    },
    required: ["session_token", "book", "chapter", "kind"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const session = await readerFrom(args, ctx);
    const book = bookArg(args);
    const chapter = intArg(args, "chapter", { min: 0, required: true })!;
    const kind = args.kind;
    if (kind !== "tn" && kind !== "tq") throw new ToolInputError('kind must be "tn" or "tq"');
    const vs = intArg(args, "verse_start", { min: 0 }) ?? 0;
    const ve = intArg(args, "verse_end", { min: 0 }) ?? Number.MAX_SAFE_INTEGER;
    if (ve < vs) throw new ToolInputError("verse_end is before verse_start");
    const limit = Math.min(intArg(args, "limit", { min: 1 }) ?? DEFAULT_PAGE_ROWS, MAX_PAGE_ROWS);
    const cursor = parseCursor(args.cursor);
    // The tA filter matches on the last path segment, so the short name, the
    // full rc:// link and a bare name without "figs-" find the same notes.
    let ta: string | null = null;
    if (args.support_reference !== undefined && args.support_reference !== null) {
      if (kind !== "tn") throw new ToolInputError("support_reference only applies to kind tn");
      ta = typeof args.support_reference === "string"
        ? shortSupport(args.support_reference.trim().replace(/\/+$/, "")).toLowerCase()
        : "";
      if (!ta) throw new ToolInputError('support_reference must be a tA article name like "figs-metaphor"');
    }

    const body = await apiGet(session, `/api/chapters/${book}/${chapter}`);
    const all = ((body[kind] as Record<string, unknown>[] | undefined) ?? []).filter((r) => {
      const v = Number(r.verse);
      if (v < vs || v > ve) return false;
      if (ta !== null) {
        const sr = typeof r.support_reference === "string" ? shortSupport(r.support_reference).toLowerCase() : "";
        if (sr !== ta && sr !== `figs-${ta}`) return false;
      }
      return args.include_trashed === true || !r.trashed_at;
    });

    const start = cursor ? all.findIndex((r) => afterKey(sortKey(r), cursor)) : 0;
    const from = start === -1 ? all.length : start;
    // The English source, only when there are tN rows to return. Its bytes
    // are part of each row before the budget check, so pages just get shorter.
    const en = kind === "tn" && from < all.length ? await session.sourceNotes(book, chapter) : null;
    const rows: Record<string, unknown>[] = [];
    let bytes = 0;
    let i = from;
    for (; i < all.length && rows.length < limit; i++) {
      let row: Record<string, unknown> = projectRow(kind, all[i], ROW_TEXT_CAP);
      if (en) {
        const text = en.ok ? en.notes.get(String(all[i].id)) : undefined;
        const cut = text === undefined ? null : capText(text, ROW_TEXT_CAP);
        row = fitEnNote({ ...row, en_note: cut ? cut.text : null, en_truncated: cut?.cut || undefined }, PAGE_BYTE_BUDGET);
      }
      const size = byteLength(row);
      // Always return at least one row, or the cursor would never move.
      if (rows.length > 0 && bytes + size > PAGE_BYTE_BUDGET) break;
      rows.push(row);
      bytes += size;
    }
    let note: string | null = null;
    // So "no such notes" is not read as a failed English source, and a
    // misspelled article name is not read as an answer.
    if (ta !== null && all.length === 0) {
      note = `No notes in this range use the tA article "${ta}". If that name may be misspelled, check the ta field of the chapter's rows.`;
    } else if (en && !en.ok) note = `en_note is null on every row: ${en.reason}`;
    else if (en?.ok) {
      // A row whose en_note was dropped to fit the page is not "missing".
      const missing = rows.filter((r) => r.en_note === null && !r.en_truncated).length;
      if (missing > 0) {
        note = `${missing} of these notes have no English note with the same id in ${en.source} (added in this project, or the id changed), so their en_note is null.`;
      }
    }
    return {
      book,
      chapter,
      kind,
      verse_start: vs,
      verse_end: ve === Number.MAX_SAFE_INTEGER ? null : ve,
      ...(ta !== null ? { support_reference: ta } : {}),
      total: all.length,
      returned: rows.length,
      next_cursor: i < all.length ? JSON.stringify(sortKey(all[i - 1])) : null,
      ...(kind === "tn" ? { en_source: en?.ok ? en.source : null, note } : {}),
      rows,
    };
  },
};

// bpt_get_row's size, measured as the result travels (see GET_ROW_BYTE_BUDGET).
const getRowBytes = (v: unknown) => byteLength(JSON.stringify(v));

// bpt_get_row's English fields for a tn row. The row's own text is returned
// whole (this tool's promise, and the place chunk_work's `truncated` sends a
// reviewer). The invariant: adding the English fields never pushes the result
// over GET_ROW_BYTE_BUDGET, on any path. Each path builds its full answer and
// then falls back, in order, until one fits: en_note cut to the longest prefix
// that fits; en_note null; the shortest status; only `en_note: null,
// en_truncated: true`; and last the bare row with no English fields at all.
// A row already over the budget on its own is returned bare, with no English
// fields and no source read: the budget sits 2,000 bytes under BT Servant's
// real 32 KB cap, so such a row may still be deliverable, and any byte added
// could tip it over. The explanation is en_note_status, not `note` as
// chunk_work's page has, because a tn row's `note` is its own text.
async function withEnNote(
  row: Record<string, unknown>,
  id: string,
  sourceNotes: () => Promise<SourceNotes>,
): Promise<Record<string, unknown>> {
  const fits = (r: Record<string, unknown>) => getRowBytes(r) <= GET_ROW_BYTE_BUDGET;
  if (!fits(row)) return row;
  const leftOut = { ...row, en_note: null, en_truncated: true };
  const en = await sourceNotes();
  let full: Record<string, unknown>;
  let short: Record<string, unknown>;
  if (!en.ok) {
    full = { ...row, en_note: null, en_source: null, en_note_status: `en_note is null: ${en.reason}` };
    short = { ...row, en_note: null, en_source: null, en_note_status: "English source unreadable." };
  } else {
    const text = en.notes.get(id);
    if (text === undefined) {
      full = {
        ...row,
        en_note: null,
        en_source: en.source,
        en_note_status: `${en.source} has no English note with the same id (added in this project, or the id changed), so en_note is null.`,
      };
      short = { ...row, en_note: null, en_source: en.source, en_note_status: "No English note with this id." };
    } else {
      // The whole note with no status first; only a note that does not fit
      // whole is cut, with the status that says so counted in.
      const whole: Record<string, unknown> = { ...row, en_note: text, en_source: en.source, en_note_status: null };
      const fitted = fits(whole) ? whole : fitEnNote({
        ...whole,
        en_note_status: `en_note was cut to keep this response under the chat's 32 KB limit; the whole English note is row ${id} in ${en.source}.`,
      }, GET_ROW_BYTE_BUDGET, getRowBytes);
      if (!fitted.en_truncated) full = whole;
      else if (fitted.en_note === null) {
        full = {
          ...fitted,
          en_note_status: `en_note was left out because this note's own text fills the chat's 32 KB limit; the English note is row ${id} in ${en.source}.`,
        };
      } else full = fitted;
      short = { ...row, en_note: null, en_source: en.source, en_truncated: true, en_note_status: "Left out for size." };
    }
  }
  return [full, short, leftOut].find(fits) ?? row;
}

const getRow: ToolDef = {
  name: "bpt_get_row",
  description:
    "One translation note (tn) or question (tq) by id, with its full current text, state and version. A tn row also has en_note: the published English note it was translated from (en_source names where), for comparison, as much of it as fits in one response. en_note is null when the English source has no note with that id, or when the English source could not be read. When the response would pass the size limit, en_note is cut or left out (null) and en_truncated is true. en_note_status says why when there is room for it. A note whose own text already fills the size limit comes back with no English fields at all.",
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      book: { type: "string", description: "3-letter book code, e.g. TIT" },
      kind: { type: "string", enum: ["tn", "tq"] },
      id: { type: "string", description: "Row id from bpt_chunk_work" },
    },
    required: ["session_token", "book", "kind", "id"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const session = await readerFrom(args, ctx);
    const book = bookArg(args);
    const kind = args.kind;
    if (kind !== "tn" && kind !== "tq") throw new ToolInputError('kind must be "tn" or "tq"');
    const id = args.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ToolInputError("id is not a row id");
    const row = await apiGet(session, `/api/rows/${kind}/${encodeURIComponent(id)}?book=${book}`);
    if (kind === "tq") return projectRow(kind, row);
    // The row's own chapter: an override can give chapters different sources.
    return withEnNote(projectRow(kind, row), id, () => session.sourceNotes(book, Number(row.chapter) || 0));
  },
};

// A verse as the chapter route serves it: verses[lane][verse].
interface VerseEntry {
  verse: number;
  verse_end?: number | null;
  content?: { verseObjects?: unknown[] } | null;
}

// One verse (or bridged block, `\v 9-10`) of the lane the chunks are read
// from, and whether a `\ts\*` marker ends it.
interface VerseUnit {
  start: number;
  end: number;
  ts: boolean;
}

// Markers are read from ULT; UST carries the same `\ts\*` markers and stands
// in when ULT is held back (a lane waiting on a replacement is left out of
// the chapter payload, chapters.ts). The source text only numbers the verses.
const MARKER_LANES = ["ULT", "UST"];
const SOURCE_LANES = ["UHB", "UGNT"];

// usfm-js parks a `\ts\*` as the last node of the verse it follows, so a
// marker anywhere in a verse's top-level nodes ends the chunk at that verse.
// Verse 0 is the chapter's front matter and belongs to no chunk.
function verseUnits(laneVerses: Record<string, VerseEntry>): VerseUnit[] {
  return Object.values(laneVerses)
    .filter((v) => Number(v.verse) > 0)
    .map((v) => {
      const start = Number(v.verse);
      const end = Math.max(start, Number(v.verse_end ?? start));
      const nodes = v.content?.verseObjects;
      return { start, end, ts: Array.isArray(nodes) && nodes.some(isTsMilestone) };
    })
    .sort((a, b) => a.start - b.start);
}

// Groups verse units into chunks: at each marker, or once a chunk spans at
// least `by` verse numbers. The chunks cover verse 1 through `lastVerse` with
// no gaps: each starts right after the previous one ends, so a verse missing
// from the lane still lands in a chunk (with `by`, a missing verse counts
// toward n, since n is a span of verse numbers), and the last chunk stretches
// to `lastVerse` so notes past the lane's last verse are not lost. A bridged
// verse is never split across two chunks.
function groupUnits(units: VerseUnit[], by: number | null, lastVerse: number): { start: number; end: number }[] {
  const chunks: { start: number; end: number }[] = [];
  let next = 1;
  let cur: { start: number; end: number } | null = null;
  for (const u of units) {
    if (cur) cur.end = Math.max(cur.end, u.end);
    else cur = { start: next, end: Math.max(next, u.end) };
    const full = by === null ? u.ts : cur.end - cur.start + 1 >= by;
    if (full) {
      chunks.push(cur);
      next = cur.end + 1;
      cur = null;
    }
  }
  if (cur) chunks.push(cur);
  const last = chunks.at(-1);
  if (last && lastVerse > last.end) last.end = lastVerse;
  return chunks;
}

const chunkList: ToolDef = {
  name: "bpt_chunks",
  description:
    "Split one chapter into review chunks, each with how many translation notes (tN) and questions (tQ) it holds (trashed ones left out). By default the chapter's \\ts\\* chunk markers in ULT decide the chunks (UST's if ULT is unavailable). Pass by: n to split every n verses instead. If the chapter has no markers and no by is given, the whole chapter comes back as one chunk with a note saying so. The chunks cover the whole chapter with no gaps, from verse 1 to the last verse the text or any note uses. Notes on verse 0 (the chapter introduction), or with no verse number, are counted in outside_chunks. Pass a chunk's start and end to bpt_chunk_work as verse_start and verse_end.",
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      book: { type: "string", description: "3-letter book code, e.g. TIT" },
      chapter: { type: "integer", minimum: 1 },
      by: { type: "integer", minimum: 1, description: "Split every n verses instead of at the chunk markers" },
    },
    required: ["session_token", "book", "chapter"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const session = await readerFrom(args, ctx);
    const book = bookArg(args);
    const chapter = intArg(args, "chapter", { min: 1, required: true })!;
    let by: number | null;
    try {
      by = intArg(args, "by", { min: 1 }) ?? null;
    } catch {
      throw new ToolInputError("by must be a whole number of verses, 1 or more");
    }

    const body = await apiGet(session, `/api/chapters/${book}/${chapter}`);
    const verses = (body.verses as Record<string, Record<string, VerseEntry>> | undefined) ?? {};
    const hasVerses = (l: string) => verseUnits(verses[l] ?? {}).length > 0;
    const lane = [...MARKER_LANES, ...SOURCE_LANES].find(hasVerses) ?? Object.keys(verses).find(hasVerses);
    if (!lane) {
      throw new ToolInputError(`${book} ${chapter} has no verses in this project. Call bpt_package_status for the chapters it has.`);
    }
    const units = verseUnits(verses[lane]);
    const notes: string[] = [];
    if (lane !== "ULT") notes.push(`ULT is not available in this project, so the ${lane} text was used.`);

    let split: "ts_markers" | "every_n_verses" | "whole_chapter";
    if (by !== null) {
      split = "every_n_verses";
    } else if (units.some((u) => u.ts)) {
      split = "ts_markers";
    } else {
      split = "whole_chapter";
      notes.push(
        MARKER_LANES.includes(lane)
          ? `${lane} has no \\ts\\* markers in this chapter, so it is one chunk. Pass by: n to split it every n verses.`
          : "The source text carries no chunk markers, so the chapter is one chunk. Pass by: n to split it every n verses.",
      );
    }
    // Live rows only, the same rule bpt_chunk_work and the book summary use.
    const live = (k: "tn" | "tq") =>
      ((body[k] as Record<string, unknown>[] | undefined) ?? []).filter((r) => !r.trashed_at).map((r) => Number(r.verse));
    const tnVerses = live("tn");
    const tqVerses = live("tq");
    const lastVerse = Math.max(
      ...units.map((u) => u.end),
      ...[...tnVerses, ...tqVerses].filter((v) => Number.isSafeInteger(v) && v > 0),
    );
    const ranges = groupUnits(units, by, lastVerse);
    const inRange = (vs: number[], s: number, e: number) => vs.filter((v) => v >= s && v <= e).length;
    const out = ranges.map((c) => ({ ...c, tn: inRange(tnVerses, c.start, c.end), tq: inRange(tqVerses, c.start, c.end) }));
    const tnIn = out.reduce((n, c) => n + c.tn, 0);
    const tqIn = out.reduce((n, c) => n + c.tq, 0);

    return {
      book,
      chapter,
      lane,
      split,
      by,
      note: notes.length ? notes.join(" ") : null,
      total_chunks: out.length,
      chunks: out,
      outside_chunks: { tn: tnVerses.length - tnIn, tq: tqVerses.length - tqIn },
    };
  },
};

// ── Writes (issue #670 part a) ──────────────────────────────────────────────
// One row at a time, pinned to the version the reviewer was shown. A row that
// moved on since is never overwritten: the result is a conflict carrying both
// the reviewer's text and the row as it is now.

const VERSION_SCHEMA = {
  type: "integer",
  minimum: 1,
  description: "The row's version exactly as bpt_chunk_work or bpt_get_row showed it to the reviewer.",
};

// The arguments every write takes, and the row as it is now. Not found and
// trashed rows are refused here, before anything is sent.
async function writeTarget(args: Record<string, unknown>, ctx: ToolContext) {
  const session = await principalFrom(args, ctx);
  const book = bookArg(args);
  if (args.kind !== "tn" && args.kind !== "tq") throw new ToolInputError('kind must be "tn" or "tq"');
  const kind: "tn" | "tq" = args.kind;
  const id = args.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ToolInputError("id is not a row id");
  const version = intArg(args, "version", { min: 1, required: true })!;
  const path = `/api/rows/${kind}/${encodeURIComponent(id)}`;
  const { status, body } = await session.getJson(`${path}?book=${book}`);
  if (status === 404) throw new ToolInputError(`There is no ${kind} row ${id} in ${book} in this project. Nothing was changed.`);
  if (status !== 200) throw new Error(`BPtranslate API ${path} returned ${status}`);
  const row = body as Record<string, unknown>;
  if (row.trashed_at) {
    throw new ToolInputError(`${kind} row ${id} is in the trash. Nothing was changed; restore it in the web app first.`);
  }
  return { session, book, kind, id, version, path, row };
}

// The answers a write route gives that are neither a success nor a conflict.
function writeRefusal(kind: "tn" | "tq", id: string, status: number, body: unknown): never {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 409 && b.error === "chapter_locked") {
    throw new ToolInputError(
      `An AI ${String(b.pipelineType ?? "")} run is working on this chapter, so ${kind} row ${id} cannot change until it finishes. Nothing was changed.`,
    );
  }
  if (status === 404) throw new ToolInputError(`${kind} row ${id} is gone. Nothing was changed.`);
  if (status === 403) throw new ToolInputError("This user cannot edit in this project. Nothing was changed.");
  if (status === 400) throw new ToolInputError(`BPtranslate refused the change (${String(b.error ?? "invalid")}). Nothing was changed.`);
  throw new Error(`BPtranslate write for ${kind} ${id} returned ${status}`);
}

// retryWith: what to call again with. An approval pins the state too, and a
// state change leaves the version as it was, so retrying with only the new
// version would conflict again.
function conflict(kind: "tn" | "tq", yours: Record<string, unknown> | null, current: Record<string, unknown>, what: string, retryWith = "current.version") {
  return {
    status: "conflict",
    message:
      `Someone changed this ${kind} row after the reviewer saw it, so ${what} was NOT saved. ` +
      `Show the reviewer the current text and ask what they want; to go ahead, call again with ${retryWith}.`,
    ...(yours ? { your_text: yours } : {}),
    current: projectRow(kind, current),
  };
}

function applied(kind: "tn" | "tq", row: Record<string, unknown>) {
  return { status: "applied", version: row.version, state: row.translation_state ?? null, row: projectRow(kind, row) };
}

const editRow: ToolDef = {
  name: "bpt_edit_row",
  description:
    "Save the reviewer's correction to one translation note (kind tn: note) or question (kind tq: question and/or response), replacing that text whole. Pass the version the reviewer was shown; the change is saved only if the row is still at that version. Returns status applied with the row's new version and state (an AI draft or approved row becomes state edited, so it needs approving again: pass the NEW version and state to bpt_approve), or status conflict when someone changed the row since, with your_text and current (the text and version now): nothing was saved, so show the reviewer the current text and ask. Errors (not found, in the trash, an AI run holding the chapter, read-only user) change nothing. Requires edit access.",
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      book: { type: "string", description: "3-letter book code, e.g. TIT" },
      kind: { type: "string", enum: ["tn", "tq"] },
      id: { type: "string", description: "Row id from bpt_chunk_work or bpt_get_row" },
      version: VERSION_SCHEMA,
      note: { type: "string", description: "tn only: the whole corrected note text" },
      question: { type: "string", description: "tq only: the whole corrected question" },
      response: { type: "string", description: "tq only: the whole corrected response" },
    },
    required: ["session_token", "book", "kind", "id", "version"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const t = await writeTarget(args, ctx);
    const fields = t.kind === "tn" ? ["note"] : ["question", "response"];
    for (const f of ["note", "question", "response"]) {
      if (!fields.includes(f) && args[f] !== undefined) throw new ToolInputError(`${f} does not apply to a ${t.kind} row`);
    }
    const patch: Record<string, string> = {};
    for (const f of fields) {
      if (args[f] === undefined) continue;
      if (typeof args[f] !== "string") throw new ToolInputError(`${f} must be text`);
      patch[f] = args[f] as string;
    }
    if (Object.keys(patch).length === 0) {
      throw new ToolInputError(t.kind === "tn" ? "note is required" : "question or response is required");
    }
    const { status, body } = await t.session.send("PATCH", `${t.path}?book=${t.book}`, patch, t.version);
    const b = (body ?? {}) as Record<string, unknown>;
    if (status === 409 && b.error === "version_mismatch") {
      return conflict(t.kind, patch, b.current as Record<string, unknown>, "the reviewer's edit");
    }
    if (status !== 200) writeRefusal(t.kind, t.id, status, body);
    return applied(t.kind, b);
  },
};

// The translation states a draft row can be in (rows.ts TRANSLATION_STATES).
const APPROVE_STATES = ["ai_draft", "edited", "validated"] as const;

const approve: ToolDef = {
  name: "bpt_approve",
  description:
    "Approve one translation note (tn) or question (tq) that the reviewer was shown and accepted, marking it validated. Only for a row the reviewer has actually read in this conversation: never approve rows they were not shown. Pass the version and state exactly as the reviewer was shown them (after bpt_edit_row, the version and state it returned); the row is approved only if it is still at that version and in that state. Returns status applied (approving does not change the version), or status conflict when the row changed since (its text, or its state: someone approved, un-approved or trashed it), with current (the text, version and state now): nothing was approved, so show the reviewer the current row first. Errors (not found, in the trash, not an AI draft, an AI run holding the chapter, read-only user) change nothing. Requires edit access.",
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      book: { type: "string", description: "3-letter book code, e.g. TIT" },
      kind: { type: "string", enum: ["tn", "tq"] },
      id: { type: "string", description: "Row id from bpt_chunk_work or bpt_get_row" },
      version: VERSION_SCHEMA,
      state: {
        type: "string",
        enum: APPROVE_STATES,
        description: "The row's state exactly as bpt_chunk_work or bpt_get_row showed it to the reviewer.",
      },
    },
    required: ["session_token", "book", "kind", "id", "version", "state"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const t = await writeTarget(args, ctx);
    // The validate route answers 404 for these too; say why instead.
    if (t.row.translation_state == null) {
      throw new ToolInputError(
        `${t.kind} row ${t.id} is not a translation draft (this project writes its notes directly), so there is nothing to approve. Nothing was changed.`,
      );
    }
    // Required (#701): state flips never bump the version, so the version alone
    // misses an un-approve or trash that landed after the reviewer saw the row.
    const state = args.state;
    if (typeof state !== "string" || !(APPROVE_STATES as readonly string[]).includes(state)) {
      throw new ToolInputError(`state is required: the row's state as the reviewer was shown it (${APPROVE_STATES.join(", ")})`);
    }
    const { status, body } = await t.session.send(
      "POST",
      `${t.path}/validate?book=${t.book}`,
      { value: 1, expected_state: state },
      t.version,
    );
    const b = (body ?? {}) as Record<string, unknown>;
    if (status === 409 && b.error === "version_mismatch") {
      return conflict(t.kind, null, b.current as Record<string, unknown>, "the approval", "current.version and current.state");
    }
    if (status !== 200) writeRefusal(t.kind, t.id, status, body);
    return applied(t.kind, b);
  },
};

// ── Note templates (issue #702) ─────────────────────────────────────────────
// A reviewer who fixes a note and states a general rule can have the bot
// rewrite the matching template. Template rows are not tn/tq row-shaped, so
// these are small twins of projectRow / conflict / applied / writeTarget.

// What the tools show of a template_units row; nothing else leaves the Worker.
function projectTemplate(u: Record<string, unknown>) {
  return {
    template_id: u.template_id,
    support_reference: shortSupport(String(u.support_ref ?? "")),
    type: (u.type as string | null) || null,
    source_md: u.source_md,
    target_md: (u.target_md as string | null) ?? null,
    state: (u.translation_state as string | null) ?? null,
    version: u.version,
  };
}

// ALL-CAPS slot names, 3+ chars, standing alone. ULT and UST are the names of
// the English source texts, which a language may rename, so they are not slots.
const CAPS_SLOT = /(?<![\p{L}\p{N}_])[A-Z][A-Z0-9_]{2,}(?![\p{L}\p{N}_])/gu;
const NOT_SLOTS = new Set(["ULT", "UST"]);
const SPAN = /\[[^\]\n]*\]|\*\*[^*\n]+\*\*/g;

// A [...] or **...** span is a slot (filled in when drafting, kept verbatim)
// only when its inner text is a slot name; any other span is example text a
// translation may translate (surveyed across the pilot's 194 templates).
function isSlotName(inner: string): boolean {
  return (
    /^(text|word)\d*$/i.test(inner) || inner.includes("_") || /^[A-Za-z]+\d+$/.test(inner) ||
    /^[A-Z][A-Z0-9]{2,}$/.test(inner)
  );
}

export function templatePlaceholders(sourceMd: string): { placeholders: string[]; examples: string[] } {
  const found: { at: number; text: string; slot: boolean }[] = [];
  for (const m of sourceMd.matchAll(CAPS_SLOT)) {
    if (!NOT_SLOTS.has(m[0])) found.push({ at: m.index!, text: m[0], slot: true });
  }
  for (const m of sourceMd.matchAll(SPAN)) {
    const inner = m[0].startsWith("[") ? m[0].slice(1, -1) : m[0].slice(2, -2);
    found.push({ at: m.index!, text: m[0], slot: isSlotName(inner.trim()) });
  }
  found.sort((a, b) => a.at - b.at);
  const placeholders: string[] = [];
  const examples: string[] = [];
  for (const f of found) {
    const list = f.slot ? placeholders : examples;
    if (!list.includes(f.text)) list.push(f.text);
  }
  return { placeholders, examples };
}

export function missingPlaceholders(placeholders: string[], text: string): string[] {
  return placeholders.filter((p) => {
    if (!/^[A-Z]/.test(p)) return !text.includes(p);
    // ASCII boundaries: a target language may join a letter to the slot
    // (Arabic writes "and SPEAKER" as one word, وSPEAKER), which still keeps it.
    const bare = new RegExp(`(?<![A-Za-z0-9_])${p}(?![A-Za-z0-9_])`);
    return !bare.test(text);
  });
}

// An editor of a translation project, nothing else: an authoring project's
// templates and tW/tA articles are the English source, not changed from chat.
// `what` names them in the refusal.
async function translationSession(
  args: Record<string, unknown>,
  ctx: ToolContext,
  what = "Its note templates are",
  refusal = `This project writes its notes in English (authoring mode). ${what} the English source and are not changed from chat.`,
): Promise<McpSession> {
  const session = await principalFrom(args, ctx);
  // send, not getJson: this route wants a signed-in user, and getJson has none.
  const { status, body } = await session.send("GET", "/api/project-config");
  if (status !== 200) throw new Error(`BPtranslate API /api/project-config returned ${status}`);
  const config = (body as { config?: ProjectConfig } | null)?.config;
  if (!config || !isTranslationConfig(config)) throw new ToolInputError(refusal);
  return session;
}

function templateIdArg(args: Record<string, unknown>): string {
  const id = args.template_id;
  // The sheet's ids are free text ("This could mean-01"); the id only travels
  // URL-encoded, so refuse just empty, overlong and control characters.
  if (typeof id !== "string" || !id.trim() || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new ToolInputError("template_id is not a template id");
  }
  return id;
}

// The template as it is now. Not found is refused here, before anything is sent.
async function getTemplate(session: McpSession, id: string, write: boolean): Promise<Record<string, unknown>> {
  const { status, body } = await session.send("GET", `/api/templates/unit?id=${encodeURIComponent(id)}`);
  if (status === 200) return body as Record<string, unknown>;
  const tail = write ? " Nothing was changed." : "";
  if (status === 404) throw new ToolInputError(`There is no note template ${id} in this project.${tail}`);
  if (status === 403) throw new ToolInputError(`This user cannot edit in this project.${tail}`);
  throw new Error(`BPtranslate API /api/templates/unit returned ${status}`);
}

// The answers a template write gives that are neither a success nor a conflict.
function templateRefusal(id: string, status: number, body: unknown): never {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 404) throw new ToolInputError(`There is no note template ${id} in this project. Nothing was changed.`);
  if (status === 403) throw new ToolInputError("This user cannot edit in this project. Nothing was changed.");
  if (status === 400) throw new ToolInputError(`BPtranslate refused the change (${String(b.error ?? "invalid")}). Nothing was changed.`);
  throw new Error(`BPtranslate write for template ${id} returned ${status}`);
}

// retryWith: what to call again with. An approval pins the state too, and a
// state change leaves the version as it was (see conflict).
function templateConflict(yours: string | null, current: Record<string, unknown>, what: string, retryWith = "current.version") {
  return {
    status: "conflict",
    message:
      `Someone changed this template after the reviewer saw it, so ${what} was NOT ${yours === null ? "made" : "saved"}. ` +
      `Show the reviewer the current wording and ask; to go ahead, call again with ${retryWith}.`,
    ...(yours !== null ? { your_text: yours } : {}),
    current: projectTemplate(current),
  };
}

function templateApplied(u: Record<string, unknown>) {
  return { status: "applied", version: u.version, state: u.translation_state ?? null, template: projectTemplate(u) };
}

interface TemplateListUnit {
  template_id: string;
  support_ref: string;
  sheet_order: number | null;
  origin: string;
}

const templatesForRow: ToolDef = {
  name: "bpt_templates_for_row",
  description:
    "The note templates behind one translation note (tn): call this when the reviewer corrects a note AND says the wording should change for all such notes, for future drafts, or in the template. Returns every template for the note's support reference, each with template_id, source_md (the English), target_md (this project's wording; null means not translated yet, so start from source_md, written in the project's language), state, version, and placeholders (slots filled in when a note is drafted: keep every one exactly as written) and examples (sample text a translation may translate). Templates come in the order the drafter reads them; feeds_drafts marks the one AI drafts read now (the first approved one), and approving wording on a template above it makes that one the template drafts read. Then use bpt_edit_template and bpt_approve_template. Requires edit access; not available in an English-authoring project.",
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      book: { type: "string", description: "3-letter book code, e.g. TIT" },
      id: { type: "string", description: "The tn row id from bpt_chunk_work or bpt_get_row" },
    },
    required: ["session_token", "book", "id"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const session = await translationSession(args, ctx);
    const book = bookArg(args);
    const id = args.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ToolInputError("id is not a row id");
    const { status, body } = await session.getJson(`/api/rows/tn/${encodeURIComponent(id)}?book=${book}`);
    if (status === 404) throw new ToolInputError(`There is no tn row ${id} in ${book} in this project.`);
    if (status !== 200) throw new Error(`BPtranslate API /api/rows/tn/${id} returned ${status}`);
    const sr = String((body as Record<string, unknown>).support_reference ?? "").trim();
    if (!sr) throw new ToolInputError(`tn row ${id} has no support reference, so no note template applies to it.`);
    const slug = shortSupport(sr);

    const list = await session.send("GET", "/api/templates");
    if (list.status === 403) throw new ToolInputError("This user cannot edit in this project.");
    if (list.status !== 200) throw new Error(`BPtranslate API /api/templates returned ${list.status}`);
    const units = ((list.body as { units?: TemplateListUnit[] } | null)?.units ?? []).filter(
      (u) => shortSupport(u.support_ref).toLowerCase() === slug.toLowerCase(),
    );
    if (units.length === 0) throw new ToolInputError(`This project has no note templates for ${slug}.`);
    // The order the context export reads them in (exportWorkflow.ts ORDER BY
    // sheet_order, template_id): SQLite puts NULL first and compares ids as bytes.
    units.sort(
      (a, b) =>
        (a.sheet_order ?? -Infinity) - (b.sheet_order ?? -Infinity) ||
        (a.template_id < b.template_id ? -1 : a.template_id > b.template_id ? 1 : 0),
    );

    const out = [];
    for (const u of units) {
      const full = await getTemplate(session, u.template_id, false);
      out.push({ unit: full, origin: u.origin });
    }
    // The one the export sends the drafter: the first sheet template that is
    // approved and has wording (exportWorkflow.ts, contextExport.ts renderTemplatesTsv).
    const feeder = out.find(
      (o) => o.origin === "sheet" && o.unit.translation_state === "validated" && String(o.unit.target_md ?? "").trim(),
    )?.unit.template_id;
    let templates: Record<string, unknown>[] = out.map((o) => ({
      ...projectTemplate(o.unit),
      feeds_drafts: o.unit.template_id === feeder,
      ...templatePlaceholders(String(o.unit.source_md ?? "")),
    }));
    // A support reference can have ten variants; with translated wording in a
    // two-byte script that can pass the chat's 32 KB cap (GET_ROW_BYTE_BUDGET).
    // Leave out the English of translated ones first (their placeholders stay
    // listed), then refuse rather than send a cut-off result.
    if (getRowBytes({ templates }) > GET_ROW_BYTE_BUDGET - 1_000) {
      templates = templates.map((t) => (t.target_md ? { ...t, source_md: null, source_left_out: true } : t));
      if (getRowBytes({ templates }) > GET_ROW_BYTE_BUDGET - 1_000) {
        throw new ToolInputError(
          `The ${units.length} templates for ${slug} are too long to send in one chat message. Edit them in the BPtranslate web app (Note Templates).`,
        );
      }
    }
    return {
      book,
      row_id: id,
      support_reference: slug,
      note:
        "AI drafts read only the feeds_drafts template (none: drafts get no template for this yet). Approved wording on a template above it in this list takes its place. Approving a template starts the context export, so new AI drafts use the wording once it finishes, usually within a few minutes.",
      templates,
    };
  },
};

// The arguments both template writes take, and the template as it is now.
async function templateWriteTarget(args: Record<string, unknown>, ctx: ToolContext) {
  const session = await translationSession(args, ctx);
  const id = templateIdArg(args);
  const version = intArg(args, "version", { min: 1, required: true })!;
  return { session, id, version, path: `/api/templates/unit?id=${encodeURIComponent(id)}` };
}

const TEMPLATE_ID_SCHEMA = { type: "string", description: "template_id from bpt_templates_for_row" };

const editTemplate: ToolDef = {
  name: "bpt_edit_template",
  description:
    "Save new wording for one note template, replacing its target_md whole. Pass the version the reviewer was shown; it is saved only if the template is still at that version. Every placeholder in the template (see bpt_templates_for_row) must stay exactly as written, or nothing is saved. Returns status applied with the new version and state (state becomes edited, so it needs approving: pass the NEW version and state to bpt_approve_template), or status conflict when someone changed the template since, with your_text and current: nothing was saved, so show the reviewer the current wording and ask. Errors change nothing. Requires edit access.",
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      template_id: TEMPLATE_ID_SCHEMA,
      version: { type: "integer", minimum: 1, description: "The template's version exactly as bpt_templates_for_row showed it to the reviewer." },
      text: { type: "string", description: "The whole new wording of the template" },
    },
    required: ["session_token", "template_id", "version", "text"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const t = await templateWriteTarget(args, ctx);
    const text = args.text;
    // An empty PATCH leaves the state NULL, and the approve would then fail.
    if (typeof text !== "string" || !text.trim()) throw new ToolInputError("text is required: the whole new wording");
    const unit = await getTemplate(t.session, t.id, true);
    // A template that moved on since the reviewer saw it is a conflict, not a
    // placeholder error about wording they never saw: the PATCH answers it.
    const missing = unit.version !== t.version ? [] : missingPlaceholders(templatePlaceholders(String(unit.source_md ?? "")).placeholders, text);
    if (missing.length > 0) {
      throw new ToolInputError(
        `Not saved: the new wording drops ${missing.join(", ")}. These are filled in when a note is drafted, so keep each exactly as written. Nothing was changed.`,
      );
    }
    const { status, body } = await t.session.send("PATCH", t.path, { target_md: text }, t.version);
    const b = (body ?? {}) as Record<string, unknown>;
    if (status === 409 && b.error === "version_mismatch") {
      return templateConflict(text, b.current as Record<string, unknown>, "the new wording");
    }
    if (status !== 200) templateRefusal(t.id, status, body);
    return templateApplied(b);
  },
};

const approveTemplate: ToolDef = {
  name: "bpt_approve_template",
  description:
    "Approve the wording of one note template that the reviewer was shown and accepted, marking it validated. Only for wording the reviewer has actually read in this conversation. Pass the version and state exactly as the reviewer was shown them (after bpt_edit_template, the version and state it returned; approving does not change the version); the template is approved only if it is still at that version and in that state. Returns status applied, or status conflict when the template changed since (its wording, or its state: someone approved or un-approved it), with current (the wording, version and state now): nothing was approved, so show the reviewer the current wording first. A template with no translation yet cannot be approved. Errors change nothing. Requires edit access.",
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      template_id: TEMPLATE_ID_SCHEMA,
      version: { type: "integer", minimum: 1, description: "The template's version exactly as bpt_edit_template returned it." },
      state: {
        type: "string",
        enum: APPROVE_STATES,
        description: "The template's state exactly as bpt_templates_for_row or bpt_edit_template showed it to the reviewer.",
      },
    },
    required: ["session_token", "template_id", "version", "state"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const t = await templateWriteTarget(args, ctx);
    // Required (#708): state flips never bump the version, so the version alone
    // misses an un-approve that landed after the reviewer saw the template.
    const state = args.state;
    if (typeof state !== "string" || !(APPROVE_STATES as readonly string[]).includes(state)) {
      throw new ToolInputError(`state is required: the template's state as the reviewer was shown it (${APPROVE_STATES.join(", ")})`);
    }
    const unit = await getTemplate(t.session, t.id, true);
    if (unit.version !== t.version) return templateConflict(null, unit, "the approval", "current.version and current.state");
    if (unit.translation_state == null) {
      throw new ToolInputError(
        `${t.id} has no translation yet, so there is nothing to approve. Save wording with bpt_edit_template first. Nothing was changed.`,
      );
    }
    const { status, body } = await t.session.send(
      "POST",
      `/api/templates/unit/validate?id=${encodeURIComponent(t.id)}`,
      { value: 1, expected_state: state },
      t.version,
    );
    const b = (body ?? {}) as Record<string, unknown>;
    if (status === 409 && b.error === "version_mismatch") {
      return templateConflict(null, b.current as Record<string, unknown>, "the approval", "current.version and current.state");
    }
    if (status !== 200) templateRefusal(t.id, status, body);
    return templateApplied(b);
  },
};

// ── tW / tA articles (issue #670 part d) ────────────────────────────────────
// The template tools' twins for article_units. One article is up to three
// markdown files (parts: a tA article has body, title and sub-title), each
// keyed by (resource, path) with its own version and state, so each part is
// saved and approved on its own. Reads go through send("GET") as the linked
// user, because the article routes are editor-only (like the template routes).

const ARTICLES_ARE = "Its tW and tA articles are";
const RESOURCE_LABEL = { tw: "tW", ta: "tA" } as const;

function articleResourceArg(args: Record<string, unknown>): "tw" | "ta" {
  if (args.resource !== "tw" && args.resource !== "ta") throw new ToolInputError('resource must be "tw" or "ta"');
  return args.resource;
}

function articlePathArg(args: Record<string, unknown>): string {
  const p = args.path;
  if (typeof p !== "string" || !p.endsWith(".md") || p.length > 200 || p.includes("..") || /[\u0000-\u001f\u007f]/.test(p)) {
    throw new ToolInputError("path is not an article part path: use the path bpt_get_article returned");
  }
  return p;
}

const articleUnitPath = (resource: "tw" | "ta", path: string) =>
  `/api/articles/${resource}/unit?path=${encodeURIComponent(path)}`;

// What the tools show of an article_units row; nothing else leaves the Worker.
function projectArticlePart(u: Record<string, unknown>) {
  return {
    path: u.path,
    part: u.part,
    source_md: u.source_md,
    target_md: (u.target_md as string | null) ?? null,
    state: (u.translation_state as string | null) ?? null,
    version: u.version,
  };
}

// The part as it is now, or null when the project has no such part.
async function getArticlePart(session: McpSession, resource: "tw" | "ta", path: string, write: boolean) {
  const { status, body } = await session.send("GET", articleUnitPath(resource, path));
  if (status === 200) return body as Record<string, unknown>;
  if (status === 404) return null;
  if (status === 403) throw new ToolInputError(`This user cannot edit in this project.${write ? " Nothing was changed." : ""}`);
  throw new Error(`BPtranslate API /api/articles/${resource}/unit returned ${status}`);
}

// The answers an article write gives that are neither a success nor a conflict.
function articleRefusal(resource: "tw" | "ta", path: string, status: number, body: unknown): never {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 404) throw new ToolInputError(`There is no ${RESOURCE_LABEL[resource]} article part ${path} in this project. Nothing was changed.`);
  if (status === 403) throw new ToolInputError("This user cannot edit in this project. Nothing was changed.");
  if (status === 400) throw new ToolInputError(`BPtranslate refused the change (${String(b.error ?? "invalid")}). Nothing was changed.`);
  throw new Error(`BPtranslate write for ${resource} ${path} returned ${status}`);
}

// Write results stay under the chat's cap too (GET_ROW_BYTE_BUDGET, as
// bpt_get_article): one long tA part is ~15 KB of English plus a two-byte
// translation. They never carry the English (the reviewer read it in
// bpt_get_article); past the cap they leave out the reviewer's own text, then
// the part's wording, keeping its version and state.
const ARTICLE_RESULT_BUDGET = GET_ROW_BYTE_BUDGET - 1_000;
const TOO_LONG = " The wording is too long to include here: call bpt_get_article to show it.";

function articleWritePart(u: Record<string, unknown>) {
  const { source_md: _english, ...part } = projectArticlePart(u);
  return part;
}

function withoutWording(part: ReturnType<typeof articleWritePart>) {
  const { target_md: _wording, ...rest } = part;
  return { ...rest, target_left_out: true };
}

// retryWith: what to call again with. An approval pins the state too, and a
// state change leaves the version as it was (see conflict).
function articleConflict(yours: string | null, current: Record<string, unknown>, what: string, retryWith = "current.version") {
  const message =
    `Someone changed this article part after the reviewer saw it, so ${what} was NOT ${yours === null ? "made" : "saved"}. ` +
    `Show the reviewer the current wording and ask; to go ahead, call again with ${retryWith}.`;
  const part = articleWritePart(current);
  const full = { status: "conflict", message, ...(yours !== null ? { your_text: yours } : {}), current: part };
  if (getRowBytes(full) <= ARTICLE_RESULT_BUDGET) return full;
  const noYours = { status: "conflict", message, ...(yours !== null ? { your_text_left_out: true } : {}), current: part };
  if (getRowBytes(noYours) <= ARTICLE_RESULT_BUDGET) return noYours;
  return { ...noYours, message: message + TOO_LONG, current: withoutWording(part) };
}

function articleApplied(u: Record<string, unknown>) {
  const part = articleWritePart(u);
  const out = { status: "applied", version: u.version, state: u.translation_state ?? null, part };
  if (getRowBytes(out) <= ARTICLE_RESULT_BUDGET) return out;
  return { ...out, part: withoutWording(part) };
}

const getArticle: ToolDef = {
  name: "bpt_get_article",
  description:
    "One translationWords (tW) or translationAcademy (tA) article, with each of its parts: path, part (body; a tA article also has title and sub-title), source_md (the English), target_md (this project's translation; null means not translated yet), state and version. Name the article the way a note or word link does: a tW link (rc://*/tw/dict/bible/kt/god) or category and name (kt/god); a tA link or support reference (rc://*/ta/man/translate/figs-aside, figs-aside). Show the reviewer a part before changing or approving it; then use bpt_edit_article and bpt_approve_article with that part's path, version and state. Requires edit access; not available in an English-authoring project.",
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      resource: { type: "string", enum: ["tw", "ta"] },
      article: { type: "string", description: "The article's link, support reference, or id (kt/god, translate/figs-aside)" },
    },
    required: ["session_token", "resource", "article"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const session = await translationSession(args, ctx, ARTICLES_ARE);
    const resource = articleResourceArg(args);
    const raw = typeof args.article === "string" ? args.article : "";
    let articleId: string;
    let paths: { path: string; part: string }[];
    if (resource === "tw") {
      const ref = parseTwRef(raw);
      if (!ref) {
        throw new ToolInputError(`"${raw}" is not a tW article: give its link (rc://*/tw/dict/bible/kt/god) or its category and name (kt/god).`);
      }
      articleId = articleIdForTw(ref);
      paths = [{ path: twPath(ref.cat, ref.slug), part: "body" }];
    } else {
      const ref = parseTaRef(raw);
      if (!ref) {
        throw new ToolInputError(`"${raw}" is not a tA article: give its link (rc://*/ta/man/translate/figs-aside) or its name (figs-aside).`);
      }
      articleId = articleIdForTa(ref);
      paths = taPaths(ref.manual, ref.slug);
    }
    const parts: Record<string, unknown>[] = [];
    for (const p of paths) {
      const u = await getArticlePart(session, resource, p.path, false);
      if (u) parts.push(projectArticlePart(u));
    }
    if (parts.length === 0) {
      throw new ToolInputError(
        `The ${RESOURCE_LABEL[resource]} article ${articleId} is not loaded into this project yet. An editor can add it in the BPtranslate web app.`,
      );
    }
    // A long tA body in a two-byte script can pass the chat's 32 KB cap
    // (GET_ROW_BYTE_BUDGET). Leave out the English of translated parts first,
    // then refuse rather than send a cut-off result.
    let out = parts;
    if (getRowBytes({ parts: out }) > GET_ROW_BYTE_BUDGET - 1_000) {
      out = parts.map((p) => (p.target_md ? { ...p, source_md: null, source_left_out: true } : p));
      if (getRowBytes({ parts: out }) > GET_ROW_BYTE_BUDGET - 1_000) {
        throw new ToolInputError(
          `The ${RESOURCE_LABEL[resource]} article ${articleId} is too long to send in one chat message. Edit it in the BPtranslate web app.`,
        );
      }
    }
    return { resource, article_id: articleId, parts: out };
  },
};

// The arguments both article writes take.
async function articleWriteTarget(args: Record<string, unknown>, ctx: ToolContext) {
  const session = await translationSession(args, ctx, ARTICLES_ARE);
  const resource = articleResourceArg(args);
  const path = articlePathArg(args);
  const version = intArg(args, "version", { min: 1, required: true })!;
  return { session, resource, path, version };
}

const ARTICLE_PATH_SCHEMA = { type: "string", description: "The part's path from bpt_get_article" };

const editArticle: ToolDef = {
  name: "bpt_edit_article",
  description:
    "Save the reviewer's wording for one part of a tW or tA article, replacing that part's translation (target_md) whole. Pass the version the reviewer was shown; it is saved only if the part is still at that version. Returns status applied with the new version and state (an AI draft or approved part becomes state edited, so it needs approving again: pass the NEW version and state to bpt_approve_article), or status conflict when someone changed the part since, with your_text and current (the wording and version now): nothing was saved, so show the reviewer the current wording and ask. A very long part comes back with your_text_left_out or target_left_out instead of the text: call bpt_get_article to show it. Errors change nothing. Requires edit access.",
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      resource: { type: "string", enum: ["tw", "ta"] },
      path: ARTICLE_PATH_SCHEMA,
      version: { type: "integer", minimum: 1, description: "The part's version exactly as bpt_get_article showed it to the reviewer." },
      text: { type: "string", description: "The whole new translation of this part, in markdown" },
    },
    required: ["session_token", "resource", "path", "version", "text"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const t = await articleWriteTarget(args, ctx);
    const text = args.text;
    // An empty PATCH leaves an untranslated part's state NULL, and the approve would then fail.
    if (typeof text !== "string" || !text.trim()) throw new ToolInputError("text is required: the whole new translation of the part");
    const { status, body } = await t.session.send("PATCH", articleUnitPath(t.resource, t.path), { target_md: text }, t.version);
    const b = (body ?? {}) as Record<string, unknown>;
    if (status === 409 && b.error === "version_mismatch") {
      return articleConflict(text, b.current as Record<string, unknown>, "the new wording");
    }
    if (status !== 200) articleRefusal(t.resource, t.path, status, body);
    return articleApplied(b);
  },
};

const approveArticle: ToolDef = {
  name: "bpt_approve_article",
  description:
    "Approve one part of a tW or tA article that the reviewer was shown and accepted, marking it validated. Only for wording the reviewer has actually read in this conversation. Pass the version and state exactly as the reviewer was shown them (after bpt_edit_article, the version and state it returned; approving does not change the version); the part is approved only if it is still at that version and in that state. Returns status applied, or status conflict when the part changed since (its wording, or its state: someone approved or un-approved it), with current (the wording, version and state now): nothing was approved, so show the reviewer the current wording first (target_left_out: too long to include, call bpt_get_article). A part with no translation yet cannot be approved. Errors change nothing. Requires edit access.",
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      resource: { type: "string", enum: ["tw", "ta"] },
      path: ARTICLE_PATH_SCHEMA,
      version: { type: "integer", minimum: 1, description: "The part's version exactly as bpt_get_article or bpt_edit_article returned it." },
      state: {
        type: "string",
        enum: APPROVE_STATES,
        description: "The part's state exactly as bpt_get_article or bpt_edit_article showed it to the reviewer.",
      },
    },
    required: ["session_token", "resource", "path", "version", "state"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const t = await articleWriteTarget(args, ctx);
    // Required: state flips never bump the version, so the version alone
    // misses an un-approve that landed after the reviewer saw the part.
    const state = args.state;
    if (typeof state !== "string" || !(APPROVE_STATES as readonly string[]).includes(state)) {
      throw new ToolInputError(`state is required: the part's state as the reviewer was shown it (${APPROVE_STATES.join(", ")})`);
    }
    const unit = await getArticlePart(t.session, t.resource, t.path, true);
    if (!unit) articleRefusal(t.resource, t.path, 404, null);
    if (unit.version !== t.version) return articleConflict(null, unit, "the approval", "current.version and current.state");
    if (unit.translation_state == null) {
      throw new ToolInputError(
        `${t.path} has no translation yet, so there is nothing to approve. Save wording with bpt_edit_article first. Nothing was changed.`,
      );
    }
    const { status, body } = await t.session.send(
      "POST",
      `/api/articles/${t.resource}/unit/validate?path=${encodeURIComponent(t.path)}`,
      { value: 1, expected_state: state },
      t.version,
    );
    const b = (body ?? {}) as Record<string, unknown>;
    if (status === 409 && b.error === "version_mismatch") {
      return articleConflict(null, b.current as Record<string, unknown>, "the approval", "current.version and current.state");
    }
    // The route answers 404 for a part that is gone AND for one whose
    // translation was cleared since the check above: re-read to say which.
    if (status === 404 && (await getArticlePart(t.session, t.resource, t.path, true))) {
      throw new ToolInputError(`${t.path} has no translation now, so there is nothing to approve. Nothing was changed.`);
    }
    if (status !== 200) articleRefusal(t.resource, t.path, status, body);
    return articleApplied(b);
  },
};

// ── Range un-approve (issue #670 part c) ────────────────────────────────────
// Moves the approved (validated) rows of a verse range back to edited, which
// the web app shows as needing review. It never approves (Benjamin, 2026-10-30:
// approval stays with bpt_approve, on rows the reviewer was shown). Two calls:
// a dry run that changes nothing and returns a confirm token signed over the
// exact id:version list it found, then a confirm that un-approves just those
// rows through the per-row validate route (value 0), each pinned to its
// version, to 'validated' and to its updated_at, so a row that changed in
// between is left alone. Not the
// admin review-state sweep (reviewState.ts): that is admin-only, chapter-wide,
// lifts the draft guard and can approve.

// One chapter per call and at most this many rows to change. A confirm makes
// one in-process validate call per row (measured in mcpWrite.test.mjs: a D1
// batch and a row re-read, plus a Durable Object broadcast), so a full confirm
// stays well under the Worker's ~1000-subrequest budget.
export const BULK_ROW_CAP = 50;
const CONFIRM_TTL_SECONDS = 10 * 60;

// What a confirm token binds: the link and workspace it was issued to (from
// the session, never an argument), the arguments, the rows the dry run found
// as sorted [id, version, updated_at], and its expiry (unix seconds).
// updated_at is there because approve and un-approve never bump the version
// but do set updated_at (rows.ts setTnTranslationState): without it, a web
// re-approval after the preview (or after an earlier confirm of the same
// token) looks exactly like the row the reviewer agreed to un-approve.
interface BulkTokenBody {
  ws: string;
  link: number;
  book: string;
  kind: "tn" | "tq";
  chapter: number;
  vs: number;
  ve: number | null;
  r: [string, number, number][];
  exp: number;
}

const toB64url = (s: string) =>
  btoa(String.fromCharCode(...utf8.encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)));

// Constant-time for equal lengths, as mcp.ts sameToken.
function sameMac(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const NOT_CHANGED = "Nothing was changed.";

// No JWT_SIGNING_KEY: refuse in plain words rather than as an internal error.
async function signedMac(session: McpSession, body: string): Promise<string> {
  const mac = await session.confirmMac(body);
  if (!mac) {
    throw new ToolInputError(
      `Moving a range back to needs review is not set up on this server (it has no signing key). Ask a BPtranslate admin. ${NOT_CHANGED}`,
    );
  }
  return mac;
}

// The confirm token's body, or a refusal saying why. A token is good only for
// the link it was issued to and exactly the arguments of its dry run.
async function openToken(raw: unknown, session: McpSession, want: Omit<BulkTokenBody, "r" | "exp" | "ws" | "link">) {
  const bad = (why: string): never => {
    throw new ToolInputError(`${why} Run the preview again (call without confirm_token) and show the reviewer the new count. ${NOT_CHANGED}`);
  };
  if (typeof raw !== "string") return bad("confirm_token must be the text the preview returned.");
  const [body, mac, extra] = raw.split(".");
  if (!body || !mac || extra !== undefined || !sameMac(mac, await signedMac(session, body))) {
    return bad("That confirm_token is not one this tool issued.");
  }
  const t = JSON.parse(fromB64url(body)) as BulkTokenBody;
  if (t.exp <= Math.floor(Date.now() / 1000)) return bad("That confirm_token has expired (they last 10 minutes).");
  const same =
    t.ws === session.workspace.slug && t.link === session.principal.linkId && t.book === want.book &&
    t.kind === want.kind && t.chapter === want.chapter && t.vs === want.vs && t.ve === want.ve;
  if (!same) return bad("That confirm_token was issued for a different preview (another book, kind, chapter, verse range or chat link).");
  return t;
}

const SKIP_REASONS = {
  trashed: "in the trash",
  not_a_draft: "not a translation draft (this project writes it directly), so it has no approval to remove",
  ai_draft: "an AI draft that was never approved: it already needs review",
  edited: "not approved: it already needs review",
  changed_just_now: "approved, but changed a moment ago: preview again in a few seconds to include it",
} as const;
// BT Servant drops a tool result over 32 KB, and with it the confirm token, so
// each skip reason lists only its first few ids (count has them all).
const SKIP_ID_CAP = 20;

// The description's export claim: approve snapshots the note into
// pre_draft_json (rows.ts setTnTranslationState) and un-approve leaves it, so
// the nightly TSV export (preDraftSnapshot.ts / publishGate.ts) ships that
// snapshot for an edited row. Exception: a row approved before migration 0049
// has no snapshot; in its own chapter the export ships the unchanged current
// text, and in a chapter from a foreign source (publishGate) it is omitted.
// The context export of AI examples reads validated rows only.
const bulkSetState: ToolDef = {
  name: "bpt_bulk_set_state",
  description:
    "Move the approved translation notes (kind tn) or questions (kind tq) of a verse range in one chapter back to needs review (state edited), for when a reviewer wants a stretch looked at again. Un-approving does not change the wording: the nightly Door43 export keeps publishing the last approved text of each such note until it is approved again, but it stops counting as an approved example for AI drafts. It NEVER approves anything: to approve, use bpt_approve on each row the reviewer has read. Always two calls. 1) Call without confirm_token: a preview that changes nothing and returns would_change (how many approved rows would go back to needs review), their ids and versions, the rows it would skip and why (AI drafts and edited rows already need review; trashed rows and rows that are not translation drafts are left alone; an approved row changed a moment ago is left out until a new preview a few seconds later), each reason with its count and at most the first 20 ids, and a confirm_token. Tell the reviewer the count and get a clear yes. 2) Call again with exactly the same book, kind, chapter, verse_start and verse_end plus confirm_token: only the rows in the preview change. A row that changed in any way since the preview (edited, approved or un-approved, reordered, or flagged keep or AI hint, or already un-approved by an earlier confirm of this same preview) is left as it is and listed in not_changed with its current state and version, so calling confirm twice is safe. remaining counts rows in the range that are approved after the call (approved or changed since the preview): run a new preview to include them. remaining is null when that count could not be read; the rows listed as applied were still changed. The token lasts 10 minutes and works only for this user's link and the same arguments; otherwise nothing changes. At most " +
    `${BULK_ROW_CAP} approved rows per call; a bigger range is refused, so narrow verse_start/verse_end. Requires edit access.`,
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      book: { type: "string", description: "3-letter book code, e.g. TIT" },
      kind: { type: "string", enum: ["tn", "tq"] },
      chapter: { type: "integer", minimum: 0 },
      verse_start: { type: "integer", minimum: 0, description: "First verse; omit for the whole chapter" },
      verse_end: { type: "integer", minimum: 0, description: "Last verse, inclusive" },
      confirm_token: { type: "string", description: "The confirm_token from the preview, once the reviewer said yes. Omit for the preview." },
    },
    required: ["session_token", "book", "kind", "chapter"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const session = await principalFrom(args, ctx);
    const book = bookArg(args);
    if (args.kind !== "tn" && args.kind !== "tq") throw new ToolInputError('kind must be "tn" or "tq"');
    const kind: "tn" | "tq" = args.kind;
    const chapter = intArg(args, "chapter", { min: 0, required: true })!;
    const vs = intArg(args, "verse_start", { min: 0 }) ?? 0;
    const ve = intArg(args, "verse_end", { min: 0 }) ?? null;
    if (ve !== null && ve < vs) throw new ToolInputError("verse_end is before verse_start");
    const scope = { book, kind, chapter, verse_start: vs, verse_end: ve };
    // The chapter's rows in the range, as the web app reads them.
    const inRange = async () => {
      const body = await apiGet(session, `/api/chapters/${book}/${chapter}`);
      return ((body[kind] as Record<string, unknown>[] | undefined) ?? []).filter((r) => {
        const v = Number(r.verse);
        return v >= vs && (ve === null || v <= ve);
      });
    };
    const approvedLive = (r: Record<string, unknown>) => r.translation_state === "validated" && !r.trashed_at;

    if (args.confirm_token === undefined || args.confirm_token === null || args.confirm_token === "") {
      // A preview with no way to sign its token is refused before any read.
      await signedMac(session, "");
      // updated_at has 1-second resolution. A row last written in this second
      // (or later, if the clock that wrote it runs ahead) is left out of the
      // token: a web un-approve and re-approve later in this same second would
      // reproduce its updated_at, and the confirm would take the newer approval
      // for the one previewed. Every token row is older than the preview, so
      // any later state flip changes its updated_at. Residual gap: this
      // compares against this isolate's clock. If the server that runs a later
      // web flip has a clock 1 s or more behind this one, an un-approve plus
      // re-approve there inside one second could write the very updated_at in
      // the token, and the confirm would un-approve that newer approval.
      const nowSec = Math.floor(Date.now() / 1000);
      const justNow = (x: Record<string, unknown>) => Number(x.updated_at) >= nowSec;
      const rows = await inRange();
      const change = rows.filter((x) => approvedLive(x) && !justNow(x));
      if (change.length > BULK_ROW_CAP) {
        throw new ToolInputError(
          `This range has ${change.length} approved ${kind} rows; this tool changes at most ${BULK_ROW_CAP} at once. Narrow verse_start/verse_end and preview again. ${NOT_CHANGED}`,
        );
      }
      const skipped = new Map<keyof typeof SKIP_REASONS, string[]>();
      for (const r of rows) {
        if (approvedLive(r) && !justNow(r)) continue;
        const reason = approvedLive(r)
          ? "changed_just_now"
          : r.trashed_at ? "trashed" : r.translation_state == null ? "not_a_draft" : r.translation_state === "ai_draft" ? "ai_draft" : "edited";
        skipped.set(reason, [...(skipped.get(reason) ?? []), String(r.id)]);
      }
      const r = change
        .map((x): [string, number, number] => [String(x.id), Number(x.version), Number(x.updated_at)])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const preview = {
        status: "preview",
        ...scope,
        would_change: r.length,
        rows: change.map((x) => ({ id: x.id, ref: `${x.book} ${x.ref_raw ?? `${x.chapter}:${x.verse}`}`, version: x.version })),
        skipped: [...skipped].map(([reason, ids]) => ({
          reason,
          why: SKIP_REASONS[reason],
          count: ids.length,
          ids: ids.slice(0, SKIP_ID_CAP),
          ...(ids.length > SKIP_ID_CAP ? { more_ids_not_listed: ids.length - SKIP_ID_CAP } : {}),
        })),
      };
      if (r.length === 0) {
        return { ...preview, message: `No approved ${kind} rows in this range, so there is nothing to move back to needs review. ${NOT_CHANGED}` };
      }
      const exp = Math.floor(Date.now() / 1000) + CONFIRM_TTL_SECONDS;
      const t: BulkTokenBody = { ws: session.workspace.slug, link: session.principal.linkId, book, kind, chapter, vs, ve, r, exp };
      const body = toB64url(JSON.stringify(t));
      return {
        ...preview,
        confirm_token: `${body}.${await signedMac(session, body)}`,
        expires_at: new Date(exp * 1000).toISOString(),
        message: `${NOT_CHANGED} Tell the reviewer that ${r.length} approved ${kind} rows would go back to needs review, and call again with confirm_token only if they say yes.`,
      };
    }

    const t = await openToken(args.confirm_token, session, { book, kind, chapter, vs, ve });
    const appliedIds: string[] = [];
    const notChanged: Record<string, unknown>[] = [];
    const changed = (id: string, cur: Record<string, unknown>) =>
      notChanged.push({
        id,
        reason: "changed_since_preview",
        why: "changed since the preview (edited, approved or un-approved, reordered, or flagged keep or AI hint), or already un-approved by an earlier confirm of this same preview",
        current_state: cur.translation_state ?? null,
        current_version: cur.version,
        trashed: cur.trashed_at ? true : undefined,
      });
    // Read the rows fresh and send a write only for those still exactly as the
    // preview saw them, updated_at included (see BulkTokenBody). The validate
    // itself pins all three, so a web un-approve plus re-approve that lands
    // between this read and that row's write is refused there (409) too. The
    // updated_at pin is airtight only because the preview left out rows written
    // in its own second (changed_just_now): every later flip writes a strictly
    // greater updated_at. Keep that filter.
    const now = new Map((await inRange()).map((x) => [String(x.id), x]));
    for (const [id, version, updatedAt] of t.r) {
      const cur = now.get(id);
      if (!cur) {
        notChanged.push({ id, reason: "gone" });
        continue;
      }
      if (!approvedLive(cur) || Number(cur.version) !== version || Number(cur.updated_at) !== updatedAt) {
        changed(id, cur);
        continue;
      }
      // value 0 only: this loop has no way to approve.
      const { status, body } = await session.send(
        "POST",
        `/api/rows/${kind}/${encodeURIComponent(id)}/validate?book=${book}`,
        { value: 0, expected_state: "validated", expected_updated_at: updatedAt },
        version,
      );
      const b = (body ?? {}) as Record<string, unknown>;
      if (status === 200) appliedIds.push(id);
      else if (status === 409 && b.error === "version_mismatch") changed(id, (b.current ?? {}) as Record<string, unknown>);
      else notChanged.push({ id, reason: status === 404 ? "gone" : `refused_${status}` });
    }
    // The rows are already changed by now, so a failed count must not turn the
    // whole result into an error.
    let remaining: number | null = null;
    try {
      remaining = (await inRange()).filter(approvedLive).length;
    } catch (e) {
      console.error("bpt_bulk_set_state: remaining count failed", e instanceof Error ? (e.stack ?? e.message) : String(e));
    }
    return {
      status: "done",
      ...scope,
      applied: appliedIds.length,
      applied_ids: appliedIds,
      not_changed: notChanged,
      remaining,
      message:
        `${appliedIds.length} ${kind} rows went back to needs review.` +
        (notChanged.length
          ? ` ${notChanged.length} were left as they are: changed since the preview (edited, approved or un-approved, reordered, or flagged keep or AI hint; or already un-approved by an earlier confirm of this same preview) or gone.`
          : "") +
        (remaining === null
          ? " How many rows in this range are approved now could not be read; preview again to see."
          : remaining
            ? ` ${remaining} rows in this range are approved now; preview again to include them.`
            : ""),
    };
  },
};

// ── Translation preferences (issue #784) ────────────────────────────────────
// The Style page's brief, instructions and common issues: one row per project
// (translation_prefs), read and saved through the web app's own
// GET / PUT /api/translation-memory/prefs. GET is editor-only, so the read goes
// through send("GET") as the linked user. PUT is admin-only in the web app, so
// the edit asks session.isAdmin first and writes through sendAsAdmin, the one
// route call that is not capped at editor. Saving queues a context export
// (the route does it), which is how the next AI drafts get the new wording.
// Terminology and examples are not here.

const PREFS_PATH = "/api/translation-memory/prefs";
const PREF_TEXT_FIELDS = ["audience", "purpose", "script_notes", "instructions_md", "common_issues_md", "notes"] as const;
type PrefTextField = (typeof PREF_TEXT_FIELDS)[number];
const PREF_FIELDS = [...PREF_TEXT_FIELDS, "register"] as const;
type PrefField = (typeof PREF_FIELDS)[number];
type Prefs = { version: number } & Record<PrefTextField, string | null> & { register: string };
const PREFS_RESULT_BUDGET = GET_ROW_BYTE_BUDGET - 1_000;
const NOT_SAVED = "Nothing was saved.";

const PREF_FIELDS_HELP =
  "audience (who the translation is for), purpose (what it is for), register (default, formal or informal: how formal AI drafts are), " +
  "script_notes (script and direction notes), instructions_md (markdown added to every AI drafting and checking prompt), " +
  "common_issues_md (markdown listing problems reviewers keep flagging), notes (the admins' own notes; not sent to the AI)";

type SendFn = (method: string, path: string, body?: unknown, ifMatch?: number) => Promise<{ status: number; body: unknown }>;

// The only routes a chat tool may call with the user's admin role. Each is
// admin-only in the web app too; adding one is a decision, not a reuse.
export const CHAT_ADMIN_ROUTES: ReadonlySet<string> = new Set([`PUT ${PREFS_PATH}`]);

// Builds session.sendAsAdmin (index.ts): refuses a route not listed above,
// re-reads the real role on every call, and answers the route's own 403
// shape, without calling it, for a user who is not an admin now.
export function adminSender(isAdmin: () => Promise<boolean>, sendAsAdminRole: SendFn): SendFn {
  return async (method, path, body, ifMatch) => {
    if (!CHAT_ADMIN_ROUTES.has(`${method} ${path}`)) throw new Error(`sendAsAdmin does not allow ${method} ${path}`);
    if (!(await isAdmin())) return { status: 403, body: { error: "forbidden", reason: "not_an_admin" } };
    return sendAsAdminRole(method, path, body, ifMatch);
  };
}

// Readable by an editor of a translation project; an authoring project has
// none (the web app shows the same refusal on its Style page).
async function prefsSession(args: Record<string, unknown>, ctx: ToolContext): Promise<McpSession> {
  return translationSession(args, ctx, "", "Translation preferences apply to translation projects only, and this project writes its notes in English.");
}

async function readPrefs(session: McpSession): Promise<Prefs> {
  const { status, body } = await session.send("GET", PREFS_PATH);
  if (status !== 200) throw new Error(`BPtranslate API ${PREFS_PATH} returned ${status}`);
  const p = ((body ?? {}) as { prefs?: Record<string, unknown> }).prefs ?? {};
  const out = { version: Number(p.version ?? 0), register: String(p.register ?? "default") } as Prefs;
  for (const f of PREF_TEXT_FIELDS) out[f] = typeof p[f] === "string" ? (p[f] as string) : null;
  return out;
}

// Whole fields, leaving out the largest text fields first until the result
// fits. A single field over the budget on its own is cut, and says so: the
// edit tool's append and replace still work on it.
function prefsView(p: Prefs, fields: PrefField[], extra: Record<string, unknown>) {
  const values: Record<string, unknown> = {};
  for (const f of fields) values[f] = p[f];
  const out = (v: Record<string, unknown>, leftOut: string[], more: Record<string, unknown> = {}) => ({
    version: p.version,
    ...extra,
    preferences: v,
    ...(leftOut.length
      ? { left_out: leftOut, left_out_note: "Too long to include together: call again with field set to one of these to read it." }
      : {}),
    ...more,
  });
  if (fields.length === 1) {
    const f = fields[0];
    const text = values[f];
    if (typeof text !== "string" || getRowBytes(out(values, [])) <= PREFS_RESULT_BUDGET) return out(values, []);
    const cut = (keep: number) => out({ [f]: text.slice(0, keep) }, [], { truncated: { field: f, chars_shown: keep, total_chars: text.length } });
    let keep = text.length;
    while (keep > 0 && getRowBytes(cut(keep)) > PREFS_RESULT_BUDGET) keep = Math.floor(keep * 0.9);
    return cut(keep);
  }
  const bySize = PREF_TEXT_FIELDS.filter((f) => typeof values[f] === "string").sort((a, b) => byteLength(values[b]) - byteLength(values[a]));
  const leftOut: string[] = [];
  for (const f of bySize) {
    if (getRowBytes(out(values, leftOut)) <= PREFS_RESULT_BUDGET) break;
    delete values[f];
    leftOut.push(f);
  }
  return out(values, leftOut);
}

function prefFieldArg(raw: unknown, key: string, allowed: readonly string[]): PrefField {
  if (typeof raw !== "string" || !allowed.includes(raw)) {
    throw new ToolInputError(`${key} must be one of ${allowed.join(", ")}, got ${JSON.stringify(raw)}. ${NOT_SAVED}`);
  }
  return raw as PrefField;
}

function plainObject(raw: unknown, key: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ToolInputError(`${key} must be an object of field: text. ${NOT_SAVED}`);
  return raw as Record<string, unknown>;
}

export interface PrefsChanges {
  set: Partial<Record<PrefField, string | null>>;
  append: Partial<Record<PrefTextField, string>>;
  replace: { field: PrefTextField; old_text: string; new_text: string }[];
}

// Parses the edit tool's three kinds of change. One field takes one kind, so
// a set never silently wins over an append to the same field.
export function parsePrefsChanges(args: Record<string, unknown>): PrefsChanges {
  const set: PrefsChanges["set"] = {};
  for (const [k, v] of Object.entries(plainObject(args.set, "set"))) {
    const f = prefFieldArg(k, "a set field", PREF_FIELDS);
    if (f === "register") {
      if (typeof v !== "string" || !(REGISTERS as readonly string[]).includes(v)) {
        throw new ToolInputError(`register must be one of ${REGISTERS.join(", ")}. ${NOT_SAVED}`);
      }
      set.register = v;
    } else {
      if (v !== null && typeof v !== "string") throw new ToolInputError(`set.${f} must be text, or null to clear it. ${NOT_SAVED}`);
      // The web app saves an emptied box as null.
      set[f] = v === null || !v.trim() ? null : v;
    }
  }
  const append: PrefsChanges["append"] = {};
  for (const [k, v] of Object.entries(plainObject(args.append, "append"))) {
    const f = prefFieldArg(k, "an append field", PREF_TEXT_FIELDS) as PrefTextField;
    if (typeof v !== "string" || !v.trim()) throw new ToolInputError(`append.${f} must be the text to add. ${NOT_SAVED}`);
    append[f] = v;
  }
  const replace: PrefsChanges["replace"] = [];
  if (args.replace !== undefined && args.replace !== null) {
    if (!Array.isArray(args.replace) || args.replace.length > 20) {
      throw new ToolInputError(`replace must be a list of at most 20 changes. ${NOT_SAVED}`);
    }
    for (const r of args.replace as unknown[]) {
      const o = plainObject(r, "each replace");
      const f = prefFieldArg(o.field, "replace field", PREF_TEXT_FIELDS) as PrefTextField;
      if (typeof o.old_text !== "string" || !o.old_text) throw new ToolInputError(`replace old_text is required. ${NOT_SAVED}`);
      if (typeof o.new_text !== "string") throw new ToolInputError(`replace new_text is required ("" removes old_text). ${NOT_SAVED}`);
      replace.push({ field: f, old_text: o.old_text, new_text: o.new_text });
    }
  }
  const kinds = new Map<string, string>();
  const claim = (f: string, kind: string) => {
    const had = kinds.get(f);
    if (had && had !== kind) throw new ToolInputError(`${f} is in both ${had} and ${kind}: give each field one kind of change. ${NOT_SAVED}`);
    kinds.set(f, kind);
  };
  for (const f of Object.keys(set)) claim(f, "set");
  for (const f of Object.keys(append)) claim(f, "append");
  for (const r of replace) claim(r.field, "replace");
  if (!kinds.size) throw new ToolInputError(`Give at least one change in set, append or replace. ${NOT_SAVED}`);
  return { set, append, replace };
}

// The new value of every changed field, from the stored values the reviewer
// was shown. Pure, so the matching rules are testable on their own.
export function applyPrefsChanges(current: Prefs, ch: PrefsChanges): Partial<Record<PrefField, string | null>> {
  const next: Partial<Record<PrefField, string | null>> = { ...ch.set };
  for (const [f, text] of Object.entries(ch.append) as [PrefTextField, string][]) {
    const had = current[f] ?? "";
    next[f] = had.trim() ? `${had.replace(/\s+$/, "")}\n\n${text}` : text;
  }
  for (const r of ch.replace) {
    const had = (r.field in next ? next[r.field] : current[r.field]) ?? "";
    const at = had.indexOf(r.old_text);
    if (at < 0) throw new ToolInputError(`${r.field} does not contain this old_text: ${JSON.stringify(r.old_text.slice(0, 200))}. ${NOT_SAVED}`);
    if (had.indexOf(r.old_text, at + 1) >= 0) {
      throw new ToolInputError(`${r.field} contains this old_text more than once; include more of the surrounding text so it matches once. ${NOT_SAVED}`);
    }
    const after = had.slice(0, at) + r.new_text + had.slice(at + r.old_text.length);
    next[r.field] = after.trim() ? after : null;
  }
  return next;
}

const prefsConflict = (version: number) => ({
  status: "conflict",
  current_version: version,
  message: `Someone changed the translation preferences after the reviewer saw them, so ${NOT_SAVED.toLowerCase()} Call bpt_get_preferences, show the reviewer what is there now, and ask before trying again.`,
});

const FIELD_SCHEMA = { type: "string", enum: [...PREF_FIELDS] };
const TEXT_FIELD_PROPS = Object.fromEntries(PREF_TEXT_FIELDS.map((f) => [f, { type: "string" }]));

const getPreferences: ToolDef = {
  name: "bpt_get_preferences",
  description:
    `This project's translation preferences, the ones on the web app's Style page that shape every AI draft: ${PREF_FIELDS_HELP}. ` +
    "Editors see every field but notes. null means not filled in. Returns version (0 means never saved), can_edit (whether this user may change them: project admins only) and preferences. " +
    "When they are too long to send together, the longest are named in left_out: call again with field set to one of them. " +
    "A single field too long even on its own comes back cut, with truncated saying how many characters were shown; append and replace in bpt_edit_preferences still work on it. " +
    "Show the reviewer the current wording before changing it with bpt_edit_preferences, and pass it this version. " +
    "Requires edit access; translation projects only. Terminology and examples are not here (use the web app). Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      field: { ...FIELD_SCHEMA, description: "Return only this field" },
    },
    required: ["session_token"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const only = args.field === undefined || args.field === null ? undefined : prefFieldArg(args.field, "field", PREF_FIELDS);
    const session = await prefsSession(args, ctx);
    const admin = await session.isAdmin();
    // The web app shows these only to admins; editors see what the AI is
    // told, but not the admins' own notes.
    if (only === "notes" && !admin) throw new ToolInputError("The notes are the admins' own; only a project admin can read them here.");
    const prefs = await readPrefs(session);
    const fields = only ? [only] : PREF_FIELDS.filter((f) => admin || f !== "notes");
    return prefsView(prefs, fields, { can_edit: admin });
  },
};

const editPreferences: ToolDef = {
  name: "bpt_edit_preferences",
  description:
    `Change this project's translation preferences (the web app's Style page): ${PREF_FIELDS_HELP}. ` +
    "They are part of every AI draft and check for everyone in the project from then on, so change only what the reviewer asked for, " +
    "show them the exact new wording, and get a clear yes first. Project admins only; anyone else is refused. " +
    "Three kinds of change, one kind per field: set (replace a field whole; null or empty clears it), append (add a paragraph at the end of a text field), " +
    "replace (swap old_text, which must appear exactly once in the field, for new_text; an empty new_text deletes it). " +
    "Prefer append and replace for instructions_md and common_issues_md, so the rest of the text stays exactly as it is. " +
    "Pass the version bpt_get_preferences showed; it is saved only if the preferences are still at that version. " +
    "Returns status applied with the new version and the changed fields' new text (or changed_left_out when too long), " +
    "or status conflict when someone changed them since: nothing was saved, so read them again and ask. " +
    "A request is limited to about 64 KB, so add very long text in several appends. " +
    "Saving starts an update of what AI drafts are told; the next drafts use the new wording once it finishes. Errors change nothing.",
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      version: { type: "integer", minimum: 0, description: "The version exactly as bpt_get_preferences showed it" },
      set: {
        type: "object",
        description: "Fields to replace whole",
        properties: {
          ...Object.fromEntries(PREF_TEXT_FIELDS.map((f) => [f, { type: ["string", "null"] }])),
          register: { type: "string", enum: [...REGISTERS] },
        },
        additionalProperties: false,
      },
      append: {
        type: "object",
        description: "Text to add at the end of a field, as a new paragraph",
        properties: TEXT_FIELD_PROPS,
        additionalProperties: false,
      },
      replace: {
        type: "array",
        maxItems: 20,
        description: "Exact text swaps, applied in order",
        items: {
          type: "object",
          properties: {
            field: { type: "string", enum: [...PREF_TEXT_FIELDS] },
            old_text: { type: "string", description: "Text now in the field, exactly once" },
            new_text: { type: "string", description: "What replaces it; empty deletes it" },
          },
          required: ["field", "old_text", "new_text"],
          additionalProperties: false,
        },
      },
    },
    required: ["session_token", "version"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const version = intArg(args, "version", { min: 0, required: true })!;
    const changes = parsePrefsChanges(args);
    const session = await prefsSession(args, ctx);
    if (!(await session.isAdmin())) {
      throw new ToolInputError(
        `Changing the translation preferences is for project admins only, and ${session.principal.username} is not one here. ${NOT_SAVED}`,
      );
    }
    const current = await readPrefs(session);
    if (current.version !== version) return prefsConflict(current.version);
    const next = applyPrefsChanges(current, changes);
    const { status, body } = await session.sendAsAdmin("PUT", PREFS_PATH, next, version);
    const b = (body ?? {}) as Record<string, unknown>;
    if (status === 409 && b.error === "version_mismatch") {
      return prefsConflict(Number((b.current as Record<string, unknown> | null)?.version ?? 0));
    }
    if (status === 403 && b.reason === "not_an_admin") {
      throw new ToolInputError(`${session.principal.username} is no longer a project admin here. ${NOT_SAVED}`);
    }
    if (status === 400 && b.error === "validation_failed") {
      const issues = (b.issues as { path?: unknown[]; message?: string }[] | undefined) ?? [];
      const what = issues.map((i) => `${String(i.path?.[0] ?? "?")}: ${i.message ?? "invalid"}`).join("; ");
      throw new ToolInputError(`BPtranslate refused the change (${what || "invalid"}). ${NOT_SAVED}`);
    }
    if (status !== 200) throw new Error(`BPtranslate write ${PREFS_PATH} returned ${status}`);
    const saved = ((b.prefs ?? {}) as Record<string, unknown>);
    const changed = Object.keys(next);
    const values = Object.fromEntries(changed.map((f) => [f, saved[f] ?? null]));
    const out = { status: "applied", version: saved.version, changed: values };
    if (getRowBytes(out) <= PREFS_RESULT_BUDGET) return out;
    return { status: "applied", version: saved.version, changed_left_out: changed };
  },
};

// ── AI draft from chat (issue #670 part b) ──────────────────────────────────
// Starts a translate run for some notes or questions through the same
// POST /api/pipelines/start the web app uses, as the linked user. Admin-only
// (Benjamin, 2026-10-30): the chat principal is capped at editor, so the
// tool asks session.isAdmin, which reads the user's real role in this
// workspace. No daily cap for the pilot. Starting a job writes no edit_log
// row; the chat origin is the job's session_key (chat/link-<id>), and the
// apply later audits as source 'ai_pipeline' like any other run.

const NOT_STARTED = "Nothing was started.";
// The bot takes verses 1 to 200 (bp-assistant StartBodySchema).
const MAX_DRAFT_VERSE = 200;

const draft: ToolDef = {
  name: "bpt_draft",
  description:
    "Start an AI draft (translate run) for some translation notes (kind tn) or questions (kind tq) in one chapter: either the rows with the given ids, or the rows of a verse range. Project admins only; anyone else is refused. Not for a whole chapter (use the web app): a range or id list that covers every row of that kind in the chapter is refused. The AI draft REPLACES the current text of every selected row, approved rows included, and they then need review again; the last approved text keeps publishing to Door43 only until the row is approved again. While it runs, tn drafts make only the selected notes read-only, but tq drafts make all of the chapter's questions read-only, for everyone in the project. It costs the project's AI budget. So tell the reviewer what will be replaced and get a clear yes first. Returns job_id and status running, queued (with queue_position: one run at a time per server) or already_running (this user already started the same draft; job_id is that run); follow it with bpt_job_status. status busy means another user's run already covers these rows: nothing new was started, and only that user (or the web app) can follow their run. Refused, with nothing started, when the book or chapter has no rows of that kind in this project, when the project has no AI key of its own set up (an admin adds one in the web app), or when it is not a gateway-language project. If the AI service refuses the run, the answer names the failed job and why; nothing is running then.",
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      book: { type: "string", description: "3-letter book code, e.g. TIT" },
      kind: { type: "string", enum: ["tn", "tq"] },
      chapter: { type: "integer", minimum: 1 },
      ids: { type: "array", items: { type: "string", maxLength: 16 }, minItems: 1, maxItems: 50, description: "Row ids to draft. Use this or verse_start, not both." },
      verse_start: { type: "integer", minimum: 1, maximum: MAX_DRAFT_VERSE, description: "First verse to draft. Use this or ids, not both." },
      verse_end: { type: "integer", minimum: 1, maximum: MAX_DRAFT_VERSE, description: "Last verse, inclusive; defaults to verse_start" },
    },
    required: ["session_token", "book", "kind", "chapter"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const session = await principalFrom(args, ctx);
    if (!(await session.isAdmin())) {
      throw new ToolInputError(
        `Starting an AI draft from chat is for project admins only, and ${session.principal.username} is not one here. An admin can start it, in chat or in the web app. ${NOT_STARTED}`,
      );
    }
    const book = bookArg(args);
    if (args.kind !== "tn" && args.kind !== "tq") throw new ToolInputError('kind must be "tn" or "tq"');
    const kind: "tn" | "tq" = args.kind;
    const chapter = intArg(args, "chapter", { min: 1, required: true })!;
    const vs = intArg(args, "verse_start", { min: 1 });
    const ve = intArg(args, "verse_end", { min: 1 });
    let ids: string[] | undefined;
    if (args.ids !== undefined && args.ids !== null) {
      if (
        !Array.isArray(args.ids) || args.ids.length < 1 || args.ids.length > 50 ||
        !args.ids.every((x) => typeof x === "string" && x.length >= 1 && x.length <= 16)
      ) {
        throw new ToolInputError(`ids must be a list of 1 to 50 row ids. ${NOT_STARTED}`);
      }
      ids = args.ids as string[];
    }
    if (ids && (vs !== undefined || ve !== undefined)) throw new ToolInputError(`Give ids or a verse range, not both. ${NOT_STARTED}`);
    // A whole chapter is a web-app action: it freezes every note in it.
    if (!ids && vs === undefined) {
      throw new ToolInputError(`Give ids or verse_start: to draft a whole chapter, use the web app. ${NOT_STARTED}`);
    }
    if (ve !== undefined && vs !== undefined && ve < vs) throw new ToolInputError(`verse_end is before verse_start. ${NOT_STARTED}`);
    for (const [key, v] of [["verse_start", vs], ["verse_end", ve]] as const) {
      if (v !== undefined && v > MAX_DRAFT_VERSE) throw new ToolInputError(`${key} must be at most ${MAX_DRAFT_VERSE}. ${NOT_STARTED}`);
    }
    // Only start a paid run that has rows to write: the chapter's rows of this
    // kind, as the web app reads them. A selection covering all of them is a
    // whole-chapter run, which belongs in the web app.
    const where = `${book} ${chapter}`;
    const { status: chStatus, body: chBody } = await session.getJson(`/api/chapters/${book}/${chapter}`);
    if (chStatus !== 200 && chStatus !== 404) throw new Error(`BPtranslate API /api/chapters/${book}/${chapter} returned ${chStatus}`);
    const rows = chStatus === 200 ? (((chBody as Record<string, unknown>)[kind] as Record<string, unknown>[] | undefined) ?? []) : [];
    if (!rows.length) throw new ToolInputError(`There are no ${kind} notes in ${where} in this project, so there is nothing to draft. ${NOT_STARTED}`);
    const WHOLE = `That is the whole chapter's ${kind}; to draft a whole chapter, use the web app. ${NOT_STARTED}`;
    if (ids) {
      const have = new Set(rows.map((r) => String(r.id)));
      const missing = ids.filter((id) => !have.has(id));
      if (missing.length) throw new ToolInputError(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not a ${kind} row in ${where}. ${NOT_STARTED}`);
      if (new Set(ids).size >= have.size) throw new ToolInputError(WHOLE);
    } else {
      const end = ve ?? vs!;
      const verses = rows.map((r) => Number(r.verse)).filter((v) => Number.isInteger(v) && v >= 1);
      if (!verses.some((v) => v >= vs! && v <= end)) {
        throw new ToolInputError(`There are no ${kind} notes in ${where}:${vs}${end !== vs ? `-${end}` : ""}, so there is nothing to draft. ${NOT_STARTED}`);
      }
      if (vs! <= Math.min(...verses) && end >= Math.max(...verses)) throw new ToolInputError(WHOLE);
    }
    const translate = ids
      ? { resourceType: kind, rowIds: ids }
      : { resourceType: kind, verseStart: vs, verseEnd: ve ?? vs };
    const { status, body } = await session.send("POST", "/api/pipelines/start", {
      pipelineType: "translate",
      book,
      startChapter: chapter,
      endChapter: chapter,
      sessionKey: `chat/link-${session.principal.linkId}`,
      translate,
    });
    const b = (body ?? {}) as Record<string, unknown>;
    const scope = { book, kind, chapter, ...(ids ? { ids } : { verse_start: vs, verse_end: ve ?? vs }) };
    if (status === 200) {
      const st = String(b.status);
      return {
        status: st,
        job_id: b.jobId,
        ...scope,
        ...(b.queuePosition !== undefined ? { queue_position: b.queuePosition } : {}),
        message:
          st === "already_running"
            ? "This user already started this draft; job_id is that run. Nothing new was started."
            : st === "queued"
              ? `The draft is queued (position ${String(b.queuePosition ?? "?")}); one run goes at a time. Check on it with bpt_job_status.`
              : "The draft is running. Check on it with bpt_job_status.",
      };
    }
    // Another user's run: no job id, since bpt_job_status shows a run only to
    // the user who started it.
    if (status === 409 && b.error === "conflict") {
      const e = (b.existing ?? {}) as Record<string, unknown>;
      const who = String(e.started_by_username ?? "Another user");
      return {
        status: "busy",
        started_by: e.started_by_username ?? null,
        state: e.state ?? null,
        ...scope,
        message: `${who} already has an AI run on these rows (${String(e.state ?? "")}). ${NOT_STARTED} Only ${who} can follow that run, in chat or in the web app; the web app also shows it to everyone in the project's AI queue.`,
      };
    }
    // Translate answers ai_provider_not_configured with no key; the older
    // pipeline types answer ai_needs_org_key. Same meaning for a reviewer.
    if (status === 409 && (b.error === "ai_provider_not_configured" || b.error === "ai_needs_org_key")) {
      throw new ToolInputError(
        `This project has no AI key of its own set up, so AI drafts cannot run. A project admin adds one in the web app. ${NOT_STARTED}`,
      );
    }
    if (status === 400 && (b.error === "not_a_gl_project" || b.error === "no_source_for_resource")) {
      throw new ToolInputError(`${String(b.message ?? "This project cannot run AI drafts for this resource.")} ${NOT_STARTED}`);
    }
    if (status === 503 && b.error === "pipeline_api_disabled") {
      throw new ToolInputError(`AI drafting is switched off on this server. ${NOT_STARTED}`);
    }
    // The job was created but the AI service refused it, so it failed: name
    // it and the reason. A plain refusal, so the assistant does not retry it
    // as an internal error.
    if (status === 502) {
      throw new ToolInputError(
        `The AI service refused the draft${b.jobId ? ` (job ${String(b.jobId)})` : ""}: ${String(b.message ?? b.error ?? "no reason given")}. Nothing is running: that job failed. Tell the reviewer; an admin can look at it in the web app.`,
      );
    }
    throw new ToolInputError(`BPtranslate refused the draft (${String(b.error ?? status)}${b.message ? `: ${String(b.message)}` : ""}). ${NOT_STARTED}`);
  },
};

const NO_SUCH_JOB = "No job with that id that you started in this project.";

const jobStatus: ToolDef = {
  name: "bpt_job_status",
  description:
    "Check on an AI draft run this user started (job_id from bpt_draft). Returns state (queued, dispatching, running, paused_for_outage, paused_for_usage_limit, done, failed, cancelled), queue_position while queued, progress (chapter, step, status) while running, error when it failed, and results: per kind (tn, tq), how many drafts the run proposed, how many were applied and how many rejected (empty until the run's output is staged), and, once done, kept_because_changed_by_people: what the run left as it was because a person changed it after the run was queued, with keys only for the kinds it kept: tn and tn_ids (notes: count and ids), tq and tq_ids (questions: count and ids), articles and article_paths (tW/tA articles: count and paths). Only the user who started the run can see it, and only in this project. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      job_id: { type: "string", maxLength: 120 },
    },
    required: ["session_token", "job_id"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const session = await readerFrom(args, ctx);
    if (typeof args.job_id !== "string" || !args.job_id.trim() || args.job_id.length > 120) throw new ToolInputError("job_id is required");
    const jobId = args.job_id.trim();
    // As the linked user: the route answers only for their own job (403 for
    // anyone else's), from this workspace's database. 403 and 404 read the
    // same so a job id cannot be probed.
    const { status, body } = await session.send("GET", `/api/pipelines/${encodeURIComponent(jobId)}`);
    const b = (body ?? {}) as Record<string, unknown>;
    if (status === 403 || status === 404) throw new ToolInputError(NO_SUCH_JOB);
    if (status === 503) throw new ToolInputError("AI drafting is switched off on this server.");
    if (status !== 200) throw new Error(`bpt_job_status: BPtranslate answered ${status} (${String(b.error ?? "")})`);
    const scope = (b.scope ?? {}) as Record<string, unknown>;
    const cur = b.current as Record<string, unknown> | undefined;
    const state = String(b.state ?? "");
    // job_id is ours: for a running proxy job the route passes the bot's
    // status through, whose jobId is the bot's own id.
    return {
      job_id: jobId,
      pipeline_type: b.pipelineType ?? null,
      book: scope.book ?? null,
      start_chapter: scope.startChapter ?? null,
      end_chapter: scope.endChapter ?? null,
      state,
      ...(b.queuePosition !== undefined ? { queue_position: b.queuePosition } : {}),
      ...(cur && state !== "failed" ? { progress: { chapter: cur.chapter ?? null, step: cur.skill ?? null, status: cur.status ?? null } } : {}),
      ...(cur && (cur.error || cur.errorKind) ? { error: { kind: cur.errorKind ?? null, message: cur.error ?? null } } : {}),
      results: await session.jobResults(jobId),
      // #729, #760: notes, questions and tW/tA articles the apply left alone
      // because a person changed them after the run was queued. A kind's keys
      // are present only when the report (applySkippedOf) carries that kind.
      ...(b.applySkipped
        ? (() => {
            const k = b.applySkipped as Record<string, unknown>;
            const list = (v: unknown) => (Array.isArray(v) ? v : []);
            const kept = {
              ...(k.tnTouched !== undefined ? { tn: Number(k.tnTouched), tn_ids: list(k.tnTouchedIds) } : {}),
              ...(k.tqTouched !== undefined ? { tq: Number(k.tqTouched), tq_ids: list(k.tqTouchedIds) } : {}),
              ...(k.articleTouched !== undefined
                ? { articles: Number(k.articleTouched), article_paths: list(k.articleTouchedPaths) }
                : {}),
            };
            return Object.keys(kept).length ? { kept_because_changed_by_people: kept } : {};
          })()
        : {}),
      updated_at: b.updatedAt ?? null,
    };
  },
};

export const TOOLS: ToolDef[] = [
  whoami, linkAccount, listBooks, packageStatus, chunkWork, getRow, chunkList, editRow, approve,
  templatesForRow, editTemplate, approveTemplate, getArticle, editArticle, approveArticle, bulkSetState, draft, jobStatus,
  getPreferences, editPreferences,
];

