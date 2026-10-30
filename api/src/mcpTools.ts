// Tools for the chat MCP endpoint (mcp.ts). Phase 1 of the "Book packages via
// chat" plan: a reviewer in BT Servant can see what a book still needs, read
// the notes for a verse range, and link the chat to their BPtranslate account
// (chatLinks.ts). Every tool but bpt_link_account takes the session_token,
// because the link decides which workspace is read (issue #676). Reads go
// through readerFrom; the writes to come go through principalFrom, so every
// write carries a real editor.
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
  // The one read that does NOT go through a route handler: the tW/tA articles
  // and note templates a book references, read straight from the workspace's
  // D1 (packageRefs.ts says why). Read-only rows; the tool sends counts only.
  packageRefs: (book: string) => Promise<PackageRefRows>;
  // The published English tN for a book, keyed by row id, read from the
  // project's translationSource on Door43 (sourceNotes.ts). Never throws.
  sourceNotes: (book: string) => Promise<SourceNotes>;
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
import { summarizePackageRefs, type PackageRefRows } from "./packageRefs.ts";
import type { SourceNotes } from "./sourceNotes.ts";

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
    return { ...common, support_reference: r.support_reference ?? null, note: note.text, truncated: note.cut || undefined };
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
    "The translation notes (kind tn) or questions (kind tq) for a verse range in one chapter, with each row's id, current text, state (ai_draft, validated, ...) and version. Each tn row also has en_note: the published English note it was translated from, for comparison (null when the English source has no note with that id or could not be read; the top-level note says why). Results are paged: if next_cursor is not null, call again with it to get the rest. Never claim a chunk is complete until next_cursor is null. A row marked truncated has long text cut; read it whole with bpt_get_row. en_truncated means the English note was cut, or left out (null) to keep the page under the size limit; bpt_get_row returns as much of it as fits in one response, and sets en_truncated again if it still had to cut.",
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

    const body = await apiGet(session, `/api/chapters/${book}/${chapter}`);
    const all = ((body[kind] as Record<string, unknown>[] | undefined) ?? []).filter((r) => {
      const v = Number(r.verse);
      if (v < vs || v > ve) return false;
      return args.include_trashed === true || !r.trashed_at;
    });

    const start = cursor ? all.findIndex((r) => afterKey(sortKey(r), cursor)) : 0;
    const from = start === -1 ? all.length : start;
    // The English source, only when there are tN rows to return. Its bytes
    // are part of each row before the budget check, so pages just get shorter.
    const en = kind === "tn" && from < all.length ? await session.sourceNotes(book) : null;
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
    if (en && !en.ok) note = `en_note is null on every row: ${en.reason}`;
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
    return withEnNote(projectRow(kind, row), id, () => session.sourceNotes(book));
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

export const TOOLS: ToolDef[] = [whoami, linkAccount, listBooks, packageStatus, chunkWork, getRow, chunkList];
