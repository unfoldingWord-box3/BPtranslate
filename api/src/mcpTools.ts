// Read-only tools for the chat MCP endpoint (mcp.ts). Phase 1 of the "Book
// packages via chat" plan: a reviewer in BT Servant can see what a book still
// needs and read the notes for a verse range. No writes here — those wait for
// the account link, so every write carries a real user.
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
}

export class ToolInputError extends Error {}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

// BT Servant caps a tool result at 32 KB and drops what is over. Paged tools
// stop adding rows at this budget and hand back a cursor instead, so a long
// chapter is never cut off silently.
export const PAGE_BYTE_BUDGET = 24_000;
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
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < opts.min) {
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
    "Which BPtranslate language project this connection reads, and what it may do. Call once at the start of a conversation.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  run: async (_args, ctx) => ({
    workspace: ctx.workspace,
    access: "read_only",
    linked_user: null,
    note: "Read-only service connection. Drafting, editing and approving come after account linking.",
  }),
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
function projectRow(kind: "tn" | "tq", r: Record<string, unknown>) {
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
  return kind === "tn"
    ? { ...common, support_reference: r.support_reference ?? null, note: r.note ?? "" }
    : { ...common, question: r.question ?? "", response: r.response ?? "" };
}

const chunkWork: ToolDef = {
  name: "bpt_chunk_work",
  description:
    "The translation notes (kind tn) or questions (kind tq) for a verse range in one chapter, with each row's id, current text, state (ai_draft, validated, ...) and version. Results are paged: if next_cursor is not null, call again with it to get the rest. Never claim a chunk is complete until next_cursor is null.",
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
    const offset = args.cursor === undefined ? 0 : Number(args.cursor);
    if (!Number.isInteger(offset) || offset < 0) throw new ToolInputError("cursor is not one this tool returned");

    const body = await apiGet(ctx, `/api/chapters/${book}/${chapter}`);
    const all = ((body[kind] as Record<string, unknown>[] | undefined) ?? []).filter((r) => {
      const v = Number(r.verse);
      if (v < vs || v > ve) return false;
      return args.include_trashed === true || !r.trashed_at;
    });

    const rows: ReturnType<typeof projectRow>[] = [];
    let bytes = 0;
    for (let i = offset; i < all.length && rows.length < limit; i++) {
      const row = projectRow(kind, all[i]);
      const size = JSON.stringify(row).length;
      // Always return at least one row, or a single huge note would loop forever.
      if (rows.length > 0 && bytes + size > PAGE_BYTE_BUDGET) break;
      rows.push(row);
      bytes += size;
    }
    const next = offset + rows.length;
    return {
      book,
      chapter,
      kind,
      verse_start: vs,
      verse_end: ve === Number.MAX_SAFE_INTEGER ? null : ve,
      total: all.length,
      returned: rows.length,
      next_cursor: next < all.length ? String(next) : null,
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

export const TOOLS: ToolDef[] = [whoami, listBooks, packageStatus, chunkWork, getRow];
