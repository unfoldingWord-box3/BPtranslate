// Tools for the chat MCP endpoint (mcp.ts). Phase 1 of the "Book packages via
// chat" plan: a reviewer in BT Servant can see what a book still needs, read
// the notes for a verse range, and link the chat to their BPtranslate account
// (chatLinks.ts). Every tool but bpt_link_account takes the session_token,
// because the link decides which workspace is read (issue #676). Reads go
// through readerFrom; writes (bpt_edit_row, bpt_approve: issue #670 part a) go
// through principalFrom, so every write carries a real editor, and run the
// same PATCH / validate routes the web app uses, as that user, pinned to the
// version the reviewer was shown. The template tools (bpt_templates_for_row,
// bpt_edit_template, bpt_approve_template) do the same for note templates; their
// reads go through send("GET") as the linked user, because the template routes
// are editor-only and getJson carries no user.
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
import { shortSupport, summarizePackageRefs, type PackageRefRows } from "./packageRefs.ts";
import type { SourceNotes } from "./sourceNotes.ts";
import { isTranslationConfig } from "./workflowLayouts.ts";
import type { ProjectConfig } from "./projectConfig.ts";

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
  return /^(text|word)\d*$/i.test(inner) || inner.includes("_") || /^[A-Za-z]+\d+$/.test(inner);
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
// templates are the English source, not changed from chat.
async function templateSession(args: Record<string, unknown>, ctx: ToolContext): Promise<McpSession> {
  const session = await principalFrom(args, ctx);
  // send, not getJson: this route wants a signed-in user, and getJson has none.
  const { status, body } = await session.send("GET", "/api/project-config");
  if (status !== 200) throw new Error(`BPtranslate API /api/project-config returned ${status}`);
  const config = (body as { config?: ProjectConfig } | null)?.config;
  if (!config || !isTranslationConfig(config)) {
    throw new ToolInputError(
      "This project writes its notes in English (authoring mode). Its note templates are the English source and are not changed from chat.",
    );
  }
  return session;
}

function templateIdArg(args: Record<string, unknown>): string {
  const id = args.template_id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw new ToolInputError("template_id is not a template id");
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

function templateConflict(yours: string | null, current: Record<string, unknown>, what: string) {
  return {
    status: "conflict",
    message:
      `Someone changed this template after the reviewer saw it, so ${what} was NOT ${yours === null ? "made" : "saved"}. ` +
      `Show the reviewer the current wording and ask; to go ahead, call again with current.version.`,
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
    const session = await templateSession(args, ctx);
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
    const templates = out.map((o) => ({
      ...projectTemplate(o.unit),
      feeds_drafts: o.unit.template_id === feeder,
      ...templatePlaceholders(String(o.unit.source_md ?? "")),
    }));
    return {
      book,
      row_id: id,
      support_reference: slug,
      note:
        "AI drafts read only the feeds_drafts template (none: drafts get no template for this yet). Approved wording on a template above it in this list takes its place. Drafts see a change after the next context export, which does not run when a template is approved: it runs nightly on production and when the project's preferences or terms are saved.",
      templates,
    };
  },
};

// The arguments both template writes take, and the template as it is now.
async function templateWriteTarget(args: Record<string, unknown>, ctx: ToolContext) {
  const session = await templateSession(args, ctx);
  const id = templateIdArg(args);
  const version = intArg(args, "version", { min: 1, required: true })!;
  return { session, id, version, path: `/api/templates/unit?id=${encodeURIComponent(id)}` };
}

const TEMPLATE_ID_SCHEMA = { type: "string", description: "template_id from bpt_templates_for_row" };

const editTemplate: ToolDef = {
  name: "bpt_edit_template",
  description:
    "Save new wording for one note template, replacing its target_md whole. Pass the version the reviewer was shown; it is saved only if the template is still at that version. Every placeholder in the template (see bpt_templates_for_row) must stay exactly as written, or nothing is saved. Returns status applied with the new version and state (state becomes edited, so it needs approving: pass the NEW version to bpt_approve_template), or status conflict when someone changed the template since, with your_text and current: nothing was saved, so show the reviewer the current wording and ask. Errors change nothing. Requires edit access.",
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
    const missing = missingPlaceholders(templatePlaceholders(String(unit.source_md ?? "")).placeholders, text);
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
    "Approve the wording of one note template that the reviewer was shown and accepted, marking it validated. Only for wording the reviewer has actually read in this conversation. Pass the version bpt_edit_template returned (approving does not change the version). Returns status applied, or status conflict when the template changed since: nothing was approved, so show the reviewer the current wording first. A template with no translation yet cannot be approved. Errors change nothing. Requires edit access.",
  inputSchema: {
    type: "object",
    properties: {
      session_token: SESSION_TOKEN_SCHEMA,
      template_id: TEMPLATE_ID_SCHEMA,
      version: { type: "integer", minimum: 1, description: "The template's version exactly as bpt_edit_template returned it." },
    },
    required: ["session_token", "template_id", "version"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const t = await templateWriteTarget(args, ctx);
    const unit = await getTemplate(t.session, t.id, true);
    if (unit.translation_state == null) {
      throw new ToolInputError(
        `${t.id} has no translation yet, so there is nothing to approve. Save wording with bpt_edit_template first. Nothing was changed.`,
      );
    }
    const { status, body } = await t.session.send(
      "POST",
      `/api/templates/unit/validate?id=${encodeURIComponent(t.id)}`,
      { value: 1 },
      t.version,
    );
    const b = (body ?? {}) as Record<string, unknown>;
    if (status === 409 && b.error === "version_mismatch") {
      return templateConflict(null, b.current as Record<string, unknown>, "the approval");
    }
    if (status !== 200) templateRefusal(t.id, status, body);
    return templateApplied(b);
  },
};

export const TOOLS: ToolDef[] = [
  whoami, linkAccount, listBooks, packageStatus, chunkWork, getRow, chunkList, editRow, approve,
  templatesForRow, editTemplate, approveTemplate,
];

