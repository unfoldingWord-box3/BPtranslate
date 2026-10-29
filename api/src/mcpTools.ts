// Tools for the chat MCP endpoint (mcp.ts). Phase 1 of the "Book packages via
// chat" plan: a reviewer in BT Servant can see what a book still needs, read
// the notes for a verse range, and link the chat to their BPtranslate account
// (chatLinks.ts). No writes yet; they take a session_token and use
// principalFrom below, so every write carries a real user.
//
// Each tool reads through the SAME route handlers the web app uses (`getJson`
// runs the Hono app in-process), so chat and web never disagree about counts
// or which rows are live. Tool names carry the bpt_ prefix because BT Servant
// pools every registered server's tools into one namespace.

export interface ToolContext {
  workspace: { slug: string; label: string; org: string };
  // GET a path on this Worker's own API, in-process, against the workspace's
  // env. Returns the parsed JSON body and the HTTP status.
  getJson: (path: string) => Promise<{ status: number; body: unknown }>;
  claimLink: (code: string) => Promise<ClaimResult>;
  resolveSession: (token: string) => Promise<ChatPrincipal | null>;
}

import type { ChatPrincipal, ClaimResult } from "./chatLinks.ts";

export class ToolInputError extends Error {}

const NOT_LINKED =
  "This chat is not linked to a BPtranslate account, or the link expired or was revoked. " +
  "In the BPtranslate web app, open the account menu, choose Link chat assistant, and send the code here.";

// Who a tool call acts as. The token is a secret the user's own memory holds;
// it is never echoed back, not even in an error.
export async function principalFrom(args: Record<string, unknown>, ctx: ToolContext): Promise<ChatPrincipal> {
  const token = args.session_token;
  if (typeof token !== "string" || !token) throw new ToolInputError(NOT_LINKED);
  const principal = await ctx.resolveSession(token);
  if (!principal) throw new ToolInputError(NOT_LINKED);
  return principal;
}

const SESSION_TOKEN_SCHEMA = {
  type: "string",
  description: "The session token bpt_link_account returned for this user. Secret: never show it in a message.",
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

async function apiGet(ctx: ToolContext, path: string): Promise<Record<string, unknown>> {
  const { status, body } = await ctx.getJson(path);
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
    "Which BPtranslate language project this connection reads, and which linked user the chat acts as. Call once at the start of a conversation, with the session token if this user has one.",
  inputSchema: {
    type: "object",
    properties: { session_token: SESSION_TOKEN_SCHEMA },
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const base = { workspace: ctx.workspace };
    if (args.session_token === undefined) {
      return { ...base, linked_user: null, access: "read_only", note: NOT_LINKED };
    }
    const p = await ctx.resolveSession(String(args.session_token));
    if (!p) return { ...base, linked_user: null, access: "read_only", note: NOT_LINKED };
    return { ...base, linked_user: p.username, role: p.role, access: p.role === "editor" ? "edit" : "read_only" };
  },
};

const linkAccount: ToolDef = {
  name: "bpt_link_account",
  description:
    "Link this chat user to their BPtranslate account with the one-time code from the web app (account menu, Link chat assistant). Returns a session_token: save it in this user's memory, pass it to every tool that takes one, and never show it in a message. Only in a one-to-one chat, never in a group.",
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
        "That code did not work. Codes work once and expire after 10 minutes, and only in the project they were made in. Get a new one from the web app.",
      );
    }
    return {
      linked_user: r.principal.username,
      role: r.principal.role,
      workspace: ctx.workspace,
      session_token: r.token,
      expires_at: new Date(r.expiresAt * 1000).toISOString(),
      note: "Save session_token in this user's memory now. Never show it in a message.",
    };
  },
};

const listBooks: ToolDef = {
  name: "bpt_list_books",
  description: "Books imported into this language project, as 3-letter codes.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  run: async (_args, ctx) => {
    const body = await apiGet(ctx, "/api/books");
    const books = (body.books as { book: string }[] | undefined) ?? [];
    return { total: books.length, books: books.map((b) => b.book) };
  },
};

const packageStatus: ToolDef = {
  name: "bpt_package_status",
  description:
    "What a book still needs: per chapter, how many translation notes (tN) and translation questions (tQ) exist and how many are approved, and how many verses are marked done. Use before suggesting where to start.",
  inputSchema: {
    type: "object",
    properties: { book: { type: "string", description: "3-letter book code, e.g. TIT" } },
    required: ["book"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const book = bookArg(args);
    const body = await apiGet(ctx, `/api/chapters/${book}`);
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
    return { book, totals, chapters: rows };
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
    return { ...common, support_reference: r.support_reference ?? null, note: note.text, truncated: note.cut || undefined };
  }
  const q = capText(r.question, cap);
  const a = capText(r.response, cap);
  return { ...common, question: q.text, response: a.text, truncated: q.cut || a.cut || undefined };
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
    "The translation notes (kind tn) or questions (kind tq) for a verse range in one chapter, with each row's id, current text, state (ai_draft, validated, ...) and version. Results are paged: if next_cursor is not null, call again with it to get the rest. Never claim a chunk is complete until next_cursor is null. A row marked truncated has long text cut; read it whole with bpt_get_row.",
  inputSchema: {
    type: "object",
    properties: {
      book: { type: "string", description: "3-letter book code, e.g. TIT" },
      chapter: { type: "integer", minimum: 0 },
      kind: { type: "string", enum: ["tn", "tq"] },
      verse_start: { type: "integer", minimum: 0, description: "First verse; omit for the whole chapter" },
      verse_end: { type: "integer", minimum: 0, description: "Last verse, inclusive" },
      include_trashed: { type: "boolean", description: "Include notes a reviewer trashed (default false)" },
      cursor: { type: "string", description: "next_cursor from the previous page" },
      limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_ROWS },
    },
    required: ["book", "chapter", "kind"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const book = bookArg(args);
    const chapter = intArg(args, "chapter", { min: 0, required: true })!;
    const kind = args.kind;
    if (kind !== "tn" && kind !== "tq") throw new ToolInputError('kind must be "tn" or "tq"');
    const vs = intArg(args, "verse_start", { min: 0 }) ?? 0;
    const ve = intArg(args, "verse_end", { min: 0 }) ?? Number.MAX_SAFE_INTEGER;
    if (ve < vs) throw new ToolInputError("verse_end is before verse_start");
    const limit = Math.min(intArg(args, "limit", { min: 1 }) ?? DEFAULT_PAGE_ROWS, MAX_PAGE_ROWS);
    const cursor = parseCursor(args.cursor);

    const body = await apiGet(ctx, `/api/chapters/${book}/${chapter}`);
    const all = ((body[kind] as Record<string, unknown>[] | undefined) ?? []).filter((r) => {
      const v = Number(r.verse);
      if (v < vs || v > ve) return false;
      return args.include_trashed === true || !r.trashed_at;
    });

    const start = cursor ? all.findIndex((r) => afterKey(sortKey(r), cursor)) : 0;
    const from = start === -1 ? all.length : start;
    const rows: ReturnType<typeof projectRow>[] = [];
    let bytes = 0;
    let i = from;
    for (; i < all.length && rows.length < limit; i++) {
      const row = projectRow(kind, all[i], ROW_TEXT_CAP);
      const size = byteLength(row);
      // Always return at least one row, or the cursor would never move.
      if (rows.length > 0 && bytes + size > PAGE_BYTE_BUDGET) break;
      rows.push(row);
      bytes += size;
    }
    return {
      book,
      chapter,
      kind,
      verse_start: vs,
      verse_end: ve === Number.MAX_SAFE_INTEGER ? null : ve,
      total: all.length,
      returned: rows.length,
      next_cursor: i < all.length ? JSON.stringify(sortKey(all[i - 1])) : null,
      rows,
    };
  },
};

const getRow: ToolDef = {
  name: "bpt_get_row",
  description: "One translation note (tn) or question (tq) by id, with its full current text, state and version.",
  inputSchema: {
    type: "object",
    properties: {
      book: { type: "string", description: "3-letter book code, e.g. TIT" },
      kind: { type: "string", enum: ["tn", "tq"] },
      id: { type: "string", description: "Row id from bpt_chunk_work" },
    },
    required: ["book", "kind", "id"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const book = bookArg(args);
    const kind = args.kind;
    if (kind !== "tn" && kind !== "tq") throw new ToolInputError('kind must be "tn" or "tq"');
    const id = args.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ToolInputError("id is not a row id");
    const row = await apiGet(ctx, `/api/rows/${kind}/${encodeURIComponent(id)}?book=${book}`);
    return projectRow(kind, row);
  },
};

export const TOOLS: ToolDef[] = [whoami, linkAccount, listBooks, packageStatus, chunkWork, getRow];
