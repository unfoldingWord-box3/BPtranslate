// Unit tests for the chat MCP endpoint (mcp.ts + mcpTools.ts): one bearer for
// every workspace, the account link choosing the workspace (and nothing read
// without one), the JSON-RPC envelope, and paging that never drops rows past
// BT Servant's 32 KB tool-result cap. The in-process API is stubbed, so no D1
// is touched.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/mcp.test.mjs

import { handleMcp, isMcpPath } from "./mcp.ts";
import { GET_ROW_BYTE_BUDGET, PAGE_BYTE_BUDGET, ROW_TEXT_CAP, byteLength, principalFrom, readerFrom } from "./mcpTools.ts";

// Session tokens: one link per workspace, plus a viewer's link in bsoj and a
// link whose workspace has since been removed.
const GOOD_TOKEN = "bpt_" + "g".repeat(43);
const ML_TOKEN = "bpt_" + "m".repeat(43);
const VIEWER_TOKEN = "bpt_" + "v".repeat(43);
const GONE_TOKEN = "bpt_" + "x".repeat(43);

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const TOKEN = "t".repeat(40);
const OTHER = "o".repeat(40);
const BSOJ = { slug: "bsoj", label: "BSOJ", org: "BSOJ" };
const MLTEST = { slug: "mltest", label: "BibleEditorMLTest", org: "BibleEditorMLTest" };

function tnRow(i, verse, noteLen = 40, ch = "n") {
  return {
    id: `r${i}`, book: "TIT", chapter: 1, verse, ref_raw: `1:${verse}`,
    support_reference: "rc://*/ta/man/translate/figs-metaphor", quote: "q", occurrence: 1,
    note: ch.repeat(noteLen), translation_state: "ai_draft", version: 3, latest_source: "ai_pipeline",
    trashed_at: i === 2 ? 1700000000 : null, sort_order: i, draft_meta_json: "{}",
  };
}

// Chunk fixtures. A verse's content is usfm-js JSON; a `\ts\*` marker is the
// verse's trailing node, so it closes a chunk at that verse.
const TS_NEW = { tag: "ts\\*", nextChar: "\n" }; // usfm-js 3.5.0
const TS_EDITOR = { tag: "ts*" }; // editor-written
const TS_LEGACY = { tag: "ts", content: "\\*" }; // legacy usfm-js
function verseDto(verse, marker, verseEnd = null) {
  const words = [{ text: `w${verse}`, tag: "w", type: "word" }, { type: "text", text: ".\n\n" }];
  return { verse, verse_end: verseEnd, content: { verseObjects: marker ? [...words, marker] : words } };
}
function lane(verses, markers = {}) {
  return Object.fromEntries(verses.map((v) => [v, verseDto(v, markers[v])]));
}
const tqRow = (i, verse) => ({ ...tnRow(i, verse), id: `q${i}`, question: "q?", response: "a.", trashed_at: null });
// TIT 5: verse 0 (front matter, with a marker that must be ignored), markers
// in all three shapes, and a bridged verse 9-10 that ends the last chunk.
const CHUNK_CHAPTER = {
  verses: {
    ULT: {
      ...lane([0, 1, 2, 3, 4, 5, 6, 7, 8], { 0: TS_LEGACY, 2: TS_NEW, 4: TS_EDITOR, 6: TS_LEGACY }),
      9: verseDto(9, TS_NEW, 10),
    },
    UHB: lane([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  },
  // Verse 0 is a chapter intro note; r2 (verse 4) is trashed and not counted.
  tn: [tnRow(400, 0), tnRow(401, 1), tnRow(402, 1), tnRow(2, 4), tnRow(403, 4), tnRow(404, 10)],
  tq: [tqRow(1, 2), tqRow(3, 9)],
};

const calls = [];
// Mutable so a test can trash a row between two page requests.
let nearRow = null;
let ch1 = Array.from({ length: 30 }, (_v, i) => tnRow(i, 1 + Math.floor(i / 3)));
// Stands in for the routes, per workspace: mltest holds only OBA.
async function apiFor(ws, path) {
      calls.push({ ws: ws.slug, path });
      if (ws.slug === "mltest") {
        if (path === "/api/books") return { status: 200, body: { books: [{ book: "OBA", imported_at: 1 }] } };
        if (path === "/api/chapters/OBA") return { status: 200, body: { book: "OBA", chapters: [
          { chapter: 1, verses: 21, tn: 30, tq: 8, twl: 50, tnValidated: 0, tqValidated: 0, versesDone: 0 },
        ] } };
        return { status: 404, body: { error: "not_found" } };
      }
      if (path === "/api/books") return { status: 200, body: { books: [{ book: "TIT", imported_at: 1 }] } };
      if (path === "/api/chapters/TIT") {
        return { status: 200, body: { book: "TIT", chapters: [
          { chapter: 1, verses: 16, tn: 23, tq: 12, twl: 40, tnValidated: 5, tqValidated: 0, versesDone: 2 },
          { chapter: 2, verses: 15, tn: 20, tq: 10, twl: 30, tnValidated: 0, tqValidated: 0, versesDone: 0 },
        ] } };
      }
      if (path === "/api/chapters/GEN") return { status: 200, body: { book: "GEN", chapters: [
        { chapter: 0, verses: 0, tn: 0, tq: 0, twl: 0, tnValidated: 0, tqValidated: 0, versesDone: 0 },
      ] } };
      if (path === "/api/chapters/TIT/1") {
        return { status: 200, body: { tn: ch1, tq: [] } };
      }
      if (path === "/api/chapters/TIT/2") {
        return { status: 200, body: { tn: Array.from({ length: 20 }, (_v, i) => tnRow(i + 100, 1, 3000)), tq: [] } };
      }
      if (path === "/api/chapters/TIT/3") {
        // Arabic: two UTF-8 bytes per character, so a character count undercounts.
        return { status: 200, body: { tn: Array.from({ length: 25 }, (_v, i) => tnRow(i + 200, 1, 1500, "ع")), tq: [] } };
      }
      if (path === "/api/chapters/TIT/4") {
        return { status: 200, body: { tn: [tnRow(300, 1, 50000), tnRow(301, 2)], tq: [] } };
      }
      if (path === "/api/chapters/TIT/5") return { status: 200, body: CHUNK_CHAPTER };
      if (path === "/api/chapters/TIT/6") {
        // ULT quarantined (left out of the payload): UST carries the markers.
        return { status: 200, body: { verses: { UST: lane([1, 2, 3, 4], { 2: TS_NEW }), UHB: lane([1, 2, 3, 4]) }, tn: [], tq: [] } };
      }
      if (path === "/api/chapters/TIT/7") {
        // Both target lanes gone: only the source lane numbers the verses.
        return { status: 200, body: { verses: { ULT: {}, UHB: lane([0, 1, 2, 3, 4]) }, tn: [tnRow(500, 3)], tq: [] } };
      }
      if (path === "/api/chapters/TIT/8") return { status: 200, body: { verses: {}, tn: [], tq: [] } };
      if (path === "/api/chapters/TIT/9") return { status: 200, body: { verses: { ULT: lane([1, 2, 3, 4, 5]) }, tn: [], tq: [] } };
      if (path === "/api/chapters/TIT/10") {
        // Verse 3 is missing from the lane between two markers, and a note sits
        // on verse 7, past the lane's last verse (5).
        return { status: 200, body: {
          verses: { ULT: lane([1, 2, 4, 5], { 2: TS_NEW, 4: TS_NEW }) },
          tn: [tnRow(600, 0), tnRow(601, 3), tnRow(602, 7)],
          tq: [tqRow(603, 0), tqRow(604, 3)],
        } };
      }
      if (path === "/api/chapters/TIT/11") {
        return { status: 200, body: { tn: [tnRow(700, 1), tnRow(701, 1), tnRow(702, 2)], tq: [tqRow(703, 1)] } };
      }
      if (path === "/api/chapters/TIT/12") {
        // Arabic notes with long English sources: both count toward the budget.
        return { status: 200, body: { tn: Array.from({ length: 25 }, (_v, i) => tnRow(i + 800, 1, 1500, "ع")), tq: [] } };
      }
      if (path === "/api/chapters/TIT/13") {
        // One full-length note in a 3-byte script (Ethiopic), then a short one.
        return { status: 200, body: { tn: [tnRow(900, 1, ROW_TEXT_CAP, "ሀ"), tnRow(901, 2)], tq: [] } };
      }
      if (path === "/api/chapters/TIT/14") {
        // A note that is over the budget on its own once JSON-escaped.
        return { status: 200, body: { tn: [tnRow(950, 1, ROW_TEXT_CAP, "\u0001")], tq: [] } };
      }
      if (path.startsWith("/api/rows/tn/r5?")) return { status: 200, body: tnRow(5, 2) };
      // A long own note in a 3-byte script (Ethiopic): 12,000 bytes.
      if (path.startsWith("/api/rows/tn/r961?")) return { status: 200, body: tnRow(961, 1, 4000, "ሀ") };
      // Over the budget on its own once JSON-escaped (six bytes a character).
      if (path.startsWith("/api/rows/tn/r962?")) return { status: 200, body: tnRow(962, 1, 6000, "\u0001") };
      // A row a test sizes to sit just under bpt_get_row's budget.
      if (path.startsWith("/api/rows/tn/r963?")) return { status: 200, body: nearRow };
      if (path.startsWith("/api/rows/tq/q703?")) return { status: 200, body: tqRow(703, 1) };
      return { status: 404, body: { error: "not_found" } };
}

// Mirrors index.ts: the link names the workspace; a removed workspace is no
// session at all.
const LINKS = {
  [GOOD_TOKEN]: { ws: BSOJ, principal: { userId: 1, username: "ada", role: "editor", linkId: 9 } },
  [ML_TOKEN]: { ws: MLTEST, principal: { userId: 1, username: "ada", role: "editor", linkId: 10 } },
  [VIEWER_TOKEN]: { ws: BSOJ, principal: { userId: 3, username: "cy", role: null, linkId: 11 } },
  [GONE_TOKEN]: { ws: null, principal: { userId: 1, username: "ada", role: "editor", linkId: 12 } },
};
// Raw reference rows for bpt_package_status, per workspace (packageRefs.ts).
// bsoj translates; mltest is an authoring project, so nothing is read.
// TIT references tW kt/god (one part, validated), kt/faith (ai_draft) and
// other/paul (not loaded yet); tA figs-metaphor (title validated, body edited),
// figs-explicit (no translated part) and figs-aside (not loaded). Its notes
// use figs-metaphor as an rc:// link and figs-explicit bare; the templates
// table stores bare slugs (one with a stray rc:// form, normalized too).
const TIT_REFS = {
  translation: true,
  referenced: [
    { resource: "tw", article_id: "kt/god" },
    { resource: "tw", article_id: "kt/faith" },
    { resource: "tw", article_id: "other/paul" },
    { resource: "ta", article_id: "translate/figs-metaphor" },
    { resource: "ta", article_id: "translate/figs-explicit" },
    { resource: "ta", article_id: "translate/figs-aside" },
  ],
  articleUnits: [
    { resource: "tw", article_id: "kt/god", translation_state: "validated" },
    { resource: "tw", article_id: "kt/faith", translation_state: "ai_draft" },
    { resource: "tw", article_id: "kt/love", translation_state: "validated" }, // not referenced
    { resource: "ta", article_id: "translate/figs-metaphor", translation_state: "edited" },
    { resource: "ta", article_id: "translate/figs-metaphor", translation_state: "validated" },
    { resource: "ta", article_id: "translate/figs-metaphor", translation_state: null },
    { resource: "ta", article_id: "translate/figs-explicit", translation_state: null },
  ],
  supportRefs: ["rc://*/ta/man/translate/figs-metaphor", "figs-explicit", "rc://*/ta/man/translate/figs-hyperbole"],
  templateUnits: [
    { support_ref: "figs-metaphor", translation_state: "validated" },
    { support_ref: "figs-metaphor", translation_state: "ai_draft" },
    { support_ref: "rc://*/ta/man/translate/figs-explicit", translation_state: null },
    { support_ref: "figs-simile", translation_state: "validated" }, // not used by TIT
  ],
};
const refCalls = [];
let refsFail = false;
async function refsFor(ws, book) {
  refCalls.push({ ws: ws.slug, book });
  if (refsFail) throw new Error("D1 down");
  if (ws.slug === "mltest") return { translation: false, referenced: [], articleUnits: [], supportRefs: [], templateUnits: [] };
  return book === "TIT" ? TIT_REFS : { ...TIT_REFS, referenced: [], supportRefs: [] };
}
// The English source notes for bpt_chunk_work's en_note (sourceNotes.ts).
// Unreadable by default, so the paging tests above run without one; a test
// swaps in a map.
const NO_SOURCE = { ok: false, reason: "stub: no English source" };
let srcStub = NO_SOURCE;
const srcCalls = [];
function sessionFor(token) {
  const l = LINKS[token];
  if (!l || !l.ws) return null;
  return {
    workspace: l.ws,
    principal: l.principal,
    getJson: (path) => apiFor(l.ws, path),
    packageRefs: (book) => refsFor(l.ws, book),
    sourceNotes: async (book, chapter) => {
      srcCalls.push({ ws: l.ws.slug, book, chapter });
      return srcStub;
    },
  };
}
function deps(overrides = {}) {
  return {
    token: TOKEN,
    resolveSession: async (token) => sessionFor(token),
    claimLink: async (code) => {
      const token = { "ABCD-EFGH": GOOD_TOKEN, "MLMLMLML": ML_TOKEN, "GONEGONE": GONE_TOKEN }[code];
      const s = token && sessionFor(token);
      return s ? { ok: true, token, expiresAt: 1800000000, workspace: s.workspace, principal: s.principal } : { ok: false };
    },
    ...overrides,
  };
}

function post(body, { token = TOKEN, method = "POST", raw } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("https://x.test/api/mcp", {
    method,
    headers,
    body: method === "POST" ? (raw ?? JSON.stringify(body)) : undefined,
  });
}

async function rpc(method, params, opts = {}) {
  const res = await handleMcp(post({ jsonrpc: "2.0", id: 7, method, params }), deps(opts.deps));
  return { status: res.status, body: await res.json() };
}

async function call(name, args, { token = GOOD_TOKEN } = {}) {
  const withToken = token && name !== "bpt_link_account" ? { session_token: token, ...args } : args;
  const { body } = await rpc("tools/call", { name, arguments: withToken });
  return { isError: body.result?.isError === true, data: JSON.parse(body.result.content[0].text) };
}

console.log("[path] one path for every workspace");
assert(isMcpPath("https://x.test/api/mcp"), "/api/mcp matched");
assert(isMcpPath("https://x.test/api/mcp/"), "trailing slash tolerated");
assert(!isMcpPath("https://x.test/api/mcp/bsoj"), "the old per-workspace path is not the endpoint");
assert(!isMcpPath("https://x.test/api/chapters/TIT"), "other paths ignored");

console.log("[auth] one bearer for all workspaces");
{
  const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  let res = await handleMcp(post(body, { token: null }), deps());
  assert(res.status === 401, "missing token -> 401");
  res = await handleMcp(post(body, { token: OTHER }), deps());
  assert(res.status === 401, "wrong token -> 401");
  res = await handleMcp(post(body), deps({ token: undefined }));
  assert(res.status === 401, "no MCP_SERVICE_TOKEN -> 401");
  res = await handleMcp(post(body, { token: "short" }), deps({ token: "short" }));
  assert(res.status === 401, "a token under 32 chars is never accepted");
  res = await handleMcp(post(null, { method: "GET" }), deps());
  assert(res.status === 405, "GET -> 405");
  res = await handleMcp(post(body), deps());
  assert(res.status === 200, "the one token lists tools");
}

console.log("[jsonrpc] envelope");
{
  let res = await handleMcp(post(null, { raw: "{not json" }), deps());
  let body = await res.json();
  assert(body.error?.code === -32700, "parse error -> -32700");
  res = await handleMcp(post({ id: 1, method: "tools/list" }), deps());
  body = await res.json();
  assert(body.error?.code === -32600, "missing jsonrpc -> -32600");
  res = await handleMcp(post({ jsonrpc: "2.0", method: "notifications/initialized" }), deps());
  assert(res.status === 202, "notification -> 202, no body");
  const unknown = await rpc("resources/list", {});
  assert(unknown.body.error?.code === -32601 && unknown.body.id === 7, "unknown method -> -32601 with the request id");
  const init = await rpc("initialize", {});
  assert(init.body.result?.capabilities?.tools && init.body.result.serverInfo?.name === "bptranslate", "initialize advertises tools");
  const list = await rpc("tools/list", {});
  const names = list.body.result.tools.map((t) => t.name);
  assert(names.every((n) => n.startsWith("bpt_")), "every tool is bpt_-prefixed");
  assert(list.body.result.tools.every((t) => t.inputSchema?.type === "object"), "every tool has an object inputSchema");
  assert(!names.some((n) => /edit|approve|draft|export/.test(n)), "no write tools in the read-only slice");
  const needsToken = list.body.result.tools.filter((t) => t.name !== "bpt_link_account");
  assert(needsToken.every((t) => t.inputSchema.required?.includes("session_token")), "every tool but link_account requires session_token");
  assert(names.includes("bpt_chunks"), "tools/list includes bpt_chunks");
  const bad = await rpc("tools/call", { name: "bpt_nope", arguments: {} });
  assert(bad.body.error?.code === -32602, "unknown tool -> -32602");
}

console.log("[link] the link picks the workspace");
{
  calls.length = 0;
  for (const [name, args] of [
    ["bpt_whoami", {}],
    ["bpt_list_books", {}],
    ["bpt_package_status", { book: "TIT" }],
    ["bpt_chunk_work", { book: "TIT", chapter: 1, kind: "tn" }],
    ["bpt_get_row", { book: "TIT", kind: "tn", id: "r5" }],
    ["bpt_chunks", { book: "TIT", chapter: 5 }],
  ]) {
    const anon = await call(name, args, { token: null });
    assert(anon.isError && /Link chat assistant/.test(anon.data.error), `${name} without a token -> not linked`);
  }
  for (const t of ["bpt_revoked", GONE_TOKEN, { not: "a string" }]) {
    const dead = await call("bpt_list_books", {}, { token: t });
    assert(dead.isError && /Link chat assistant/.test(dead.data.error), `dead token (${String(t).slice(0, 8)}) -> not linked`);
    assert(!JSON.stringify(dead.data).includes(String(t)), "a dead token is not echoed back");
  }
  assert(calls.length === 0, "no API read happens without a live link");

  const a = await call("bpt_list_books", {}, { token: GOOD_TOKEN });
  const b = await call("bpt_list_books", {}, { token: ML_TOKEN });
  assert(a.data.books.join() === "TIT" && b.data.books.join() === "OBA", "same request, each token reads its own workspace");
  assert(calls.map((c) => c.ws).join() === "bsoj,mltest", "each read ran against its link's workspace only");
  const cross = await call("bpt_package_status", { book: "TIT" }, { token: ML_TOKEN });
  assert(cross.isError && calls.at(-1).ws === "mltest", "mltest's token cannot reach bsoj's book");

  const viewer = await call("bpt_list_books", {}, { token: VIEWER_TOKEN });
  assert(!viewer.isError && viewer.data.books.join() === "TIT", "a viewer's link reads");
}

console.log("[tools] reads");
{
  calls.length = 0;
  const who = await call("bpt_whoami", {});
  assert(who.data.workspace.slug === "bsoj" && who.data.access === "edit", "whoami names the workspace");
  assert(who.data.workspace.binding === undefined, "whoami does not expose the D1 binding name");

  const status = await call("bpt_package_status", { book: "tit" });
  assert(status.data.book === "TIT", "book code upper-cased");
  assert(status.data.totals.tn === 43 && status.data.totals.tnApproved === 5, "totals summed across chapters");
  assert(calls.every((c) => c.ws === "bsoj"), "every API read ran against the link's workspace");

  const notImported = await call("bpt_package_status", { book: "GEN" });
  assert(notImported.isError && /not imported/.test(notImported.data.error), "empty book -> readable error");
  const badBook = await call("bpt_package_status", { book: "Titus" });
  assert(badBook.isError && /3-letter/.test(badBook.data.error), "bad book code -> readable error, no API call");

  const row = await call("bpt_get_row", { book: "TIT", kind: "tn", id: "r5" });
  assert(row.data.id === "r5" && row.data.version === 3 && row.data.ref === "TIT 1:2", "get_row projects id, version and ref");
  assert(row.data.draft_meta_json === undefined, "internal columns are not returned");
  const missing = await call("bpt_get_row", { book: "TIT", kind: "tn", id: "zzzz" });
  assert(missing.isError, "missing row -> isError");
}

console.log("[tools] package references");
{
  refCalls.length = 0;
  const { data, isError } = await call("bpt_package_status", { book: "TIT" });
  const r = data.references;
  assert(!isError && r && refCalls.at(-1).ws === "bsoj" && refCalls.at(-1).book === "TIT", "package status reads the book's references in the link's workspace");
  assert(r.tw.referenced === 3 && r.tw.loaded === 2, "tW: three referenced, two loaded (an unreferenced article is not counted)");
  assert(r.tw.by_state.validated === 1 && r.tw.by_state.ai_draft === 1 && r.tw.by_state.not_started === 0, "tW states counted per article");
  assert(r.ta.referenced === 3 && r.ta.loaded === 2, "tA: a three-part article counts once");
  assert(r.ta.by_state.edited === 1 && r.ta.by_state.not_started === 1 && r.ta.by_state.validated === 0, "tA parts roll up like the article rail (an edited part beats a validated one)");
  assert(r.templates.support_references === 3 && r.templates.with_templates === 2, "templates: rc:// and bare support references both match bare template slugs");
  assert(r.templates.templates === 3 && r.templates.by_state.validated === 1 && r.templates.by_state.ai_draft === 1 && r.templates.by_state.not_started === 1, "every template for a used reference is counted by state");
  assert(!JSON.stringify(r).includes("kt/god"), "counts only: no article ids are returned");

  const authoring = await call("bpt_package_status", { book: "OBA" }, { token: ML_TOKEN });
  assert(!authoring.isError && authoring.data.totals.tn === 30, "an authoring project still gets its chapter counts");
  assert(authoring.data.references === null && /authoring/.test(authoring.data.references_note), "an authoring project gets no article counts, and a note saying why");

  refsFail = true;
  const realError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  let broken;
  try {
    broken = await call("bpt_package_status", { book: "TIT" });
  } finally {
    console.error = realError;
    refsFail = false;
  }
  assert(!broken.isError && broken.data.totals.tn === 43 && broken.data.chapters.length === 2, "a failed reference read still returns the chapter counts");
  assert(broken.data.references === null && /could not be read/.test(broken.data.references_note), "and says the article counts could not be read");
  assert(logged.some((l) => /D1 down/.test(l)), "the failure is logged");
  const { summarizePackageRefs } = await import("./packageRefs.ts");
  const empty = summarizePackageRefs({ translation: true, referenced: [], articleUnits: [], supportRefs: [], templateUnits: [] });
  assert(empty.tw.referenced === 0 && empty.templates.templates === 0, "a book with no references counts zero");
}

console.log("[tools] account link");
{
  const linked = await call("bpt_whoami", {});
  assert(linked.data.linked_user === "ada" && linked.data.access === "edit", "whoami with a token names the user");
  const viewer = await call("bpt_whoami", {}, { token: VIEWER_TOKEN });
  assert(viewer.data.linked_user === "cy" && viewer.data.access === "read_only", "a viewer's whoami says read only");

  const ok = await call("bpt_link_account", { code: "ABCD-EFGH" });
  assert(!ok.isError && ok.data.session_token === GOOD_TOKEN && ok.data.linked_user === "ada", "link returns the token and user");
  assert(ok.data.workspace.slug === "bsoj" && ok.data.workspace.label === "BSOJ", "link names the code's workspace and label");
  assert(ok.data.workspace.binding === undefined, "link does not expose the D1 binding name");
  assert(ok.data.access === "edit", "link says an editor can edit");
  const ml = await call("bpt_link_account", { code: "MLMLMLML" });
  assert(ml.data.workspace.slug === "mltest", "a code from another workspace links that workspace");
  const bad = await call("bpt_link_account", { code: "ZZZZ-ZZZZ" });
  assert(bad.isError && /did not work/.test(bad.data.error) && !bad.data.error.includes("ZZZZ"), "a bad code -> one generic message");
  const gone = await call("bpt_link_account", { code: "GONEGONE" });
  assert(gone.isError && /did not work/.test(gone.data.error), "a code for a removed workspace -> the same message");

  const ctx = { session: deps().resolveSession };
  let threw = null;
  try {
    await principalFrom({ session_token: "bpt_secret_wrong" }, ctx);
  } catch (e) {
    threw = e;
  }
  assert(threw && !threw.message.includes("bpt_secret_wrong"), "principalFrom refuses without echoing the token");
  const editor = await principalFrom({ session_token: GOOD_TOKEN }, ctx);
  assert(editor.principal.username === "ada" && editor.workspace.slug === "bsoj", "principalFrom resolves an editor's token and workspace");
  for (const role of [null, "viewer"]) {
    const viewerCtx = { session: async () => ({ workspace: BSOJ, principal: { userId: 3, username: "cy", role, linkId: 4 } }) };
    threw = null;
    try {
      await principalFrom({ session_token: VIEWER_TOKEN }, viewerCtx);
    } catch (e) {
      threw = e;
    }
    assert(threw && /cannot edit/.test(threw.message), `principalFrom refuses a linked reader (role ${role})`);
    assert((await readerFrom({ session_token: VIEWER_TOKEN }, viewerCtx)).principal.username === "cy", `readerFrom accepts it (role ${role})`);
  }
}

console.log("[tools] chunk paging");
{
  const first = await call("bpt_chunk_work", { book: "TIT", chapter: 1, kind: "tn", verse_start: 1, verse_end: 5 });
  // verses 1-5 hold rows 0..14; row 2 is trashed.
  assert(first.data.total === 14, "verse range filters rows and drops trashed by default");
  assert(first.data.returned === 10 && typeof first.data.next_cursor === "string", "default page of 10 with a cursor");
  const second = await call("bpt_chunk_work", { book: "TIT", chapter: 1, kind: "tn", verse_start: 1, verse_end: 5, cursor: first.data.next_cursor });
  assert(second.data.returned === 4 && second.data.next_cursor === null, "last page closes the cursor");
  const ids = new Set([...first.data.rows, ...second.data.rows].map((r) => r.id));
  assert(ids.size === 14, "no row repeated or skipped across pages");
  const withTrash = await call("bpt_chunk_work", { book: "TIT", chapter: 1, kind: "tn", verse_start: 1, verse_end: 5, include_trashed: true });
  assert(withTrash.data.total === 15, "include_trashed returns the trashed row");

  // 20 notes of 3000 chars: the byte budget, not the row limit, ends the page.
  const restart = await call("bpt_chunk_work", { book: "TIT", chapter: 1, kind: "tn", verse_start: 1, verse_end: 5, cursor: null });
  assert(restart.data.rows[0].id === first.data.rows[0].id, "cursor null means the first page");
  const junk = await call("bpt_chunk_work", { book: "TIT", chapter: 1, kind: "tn", cursor: "10" });
  assert(junk.isError, "a cursor this tool did not return -> isError");

  // A row before the cursor is trashed between pages: the keyset cursor
  // neither skips nor repeats a row, where an offset would skip one.
  const p1 = await call("bpt_chunk_work", { book: "TIT", chapter: 1, kind: "tn", limit: 5 });
  ch1 = ch1.map((r) => (r.id === "r0" ? { ...r, trashed_at: 1700000001 } : r));
  const p2 = await call("bpt_chunk_work", { book: "TIT", chapter: 1, kind: "tn", limit: 5, cursor: p1.data.next_cursor });
  const lastP1 = Number(p1.data.rows.at(-1).id.slice(1));
  assert(p2.data.rows[0].id === `r${lastP1 + 1}`, "page 2 starts right after page 1's last row");

  const big = await call("bpt_chunk_work", { book: "TIT", chapter: 2, kind: "tn", limit: 25 });
  const text = JSON.stringify(big.data);
  assert(big.data.returned < 20 && big.data.next_cursor !== null, "large notes page early with a cursor");
  assert(text.length < PAGE_BYTE_BUDGET + 2000, `page stays near the byte budget (${text.length} chars)`);

  const arabic = await call("bpt_chunk_work", { book: "TIT", chapter: 3, kind: "tn", limit: 25 });
  const arabicBytes = byteLength(arabic.data);
  assert(arabic.data.next_cursor !== null, "Arabic notes page early");
  assert(arabicBytes < PAGE_BYTE_BUDGET + 2000, `Arabic page stays under the byte budget (${arabicBytes} bytes)`);

  const huge = await call("bpt_chunk_work", { book: "TIT", chapter: 4, kind: "tn" });
  assert(huge.data.rows[0].truncated === true && huge.data.rows[0].note.length === ROW_TEXT_CAP, "a single huge note is cut and marked truncated");
  assert(huge.data.returned === 2 && byteLength(huge.data) < 32000, "a huge note does not push the page over 32 KB");

  const backwards = await call("bpt_chunk_work", { book: "TIT", chapter: 1, kind: "tn", verse_start: 5, verse_end: 1 });
  assert(backwards.isError, "verse_end before verse_start -> isError");
}

console.log("[tools] English source notes");
{
  const longEn = "e".repeat(ROW_TEXT_CAP + 500);
  srcStub = { ok: true, source: "unfoldingWord/en_tn", notes: new Map([["r700", "English\\nnote"], ["r701", longEn]]) };
  srcCalls.length = 0;
  const { data, isError } = await call("bpt_chunk_work", { book: "TIT", chapter: 11, kind: "tn" });
  const by = Object.fromEntries(data.rows.map((r) => [r.id, r]));
  assert(!isError && srcCalls.length === 1 && srcCalls[0].book === "TIT" && srcCalls[0].ws === "bsoj", "the English source is read once, for the link's workspace and book");
  assert(srcCalls[0].chapter === 11, "chunk_work reads the English source for the chapter asked for (a per-chapter override can change it, #691)");
  assert(by.r700.en_note === "English\\nnote" && by.r700.en_truncated === undefined, "en_note is the English note with the same id, in the stored form");
  assert(by.r701.en_note.length === ROW_TEXT_CAP && by.r701.en_truncated === true, "a long English note is cut and marked en_truncated");
  assert(by.r702.en_note === null, "a note with no English row gets en_note null");
  assert(data.en_source === "unfoldingWord/en_tn" && /1 of these notes/.test(data.note), "the page names the source and says how many had no match");

  srcCalls.length = 0;
  const tq = await call("bpt_chunk_work", { book: "TIT", chapter: 11, kind: "tq" });
  assert(srcCalls.length === 0 && tq.data.rows[0].en_note === undefined && tq.data.en_source === undefined, "questions get no en_note and no source read");
  const none = await call("bpt_chunk_work", { book: "TIT", chapter: 11, kind: "tn", verse_start: 9 });
  assert(none.data.returned === 0 && srcCalls.length === 0, "no rows, no source read");

  srcStub = { ok: false, reason: "Could not read the English notes tn_TIT.tsv from unfoldingWord/en_tn (HTTP 503)." };
  const down = await call("bpt_chunk_work", { book: "TIT", chapter: 11, kind: "tn" });
  assert(!down.isError && down.data.returned === 3, "an unreadable source never fails the tool");
  assert(down.data.rows.every((r) => r.en_note === null) && /HTTP 503/.test(down.data.note) && down.data.en_source === null, "every en_note is null and the note says why");

  srcStub = { ok: true, source: "unfoldingWord/en_tn", notes: new Map(Array.from({ length: 25 }, (_v, i) => [`r${800 + i}`, "E".repeat(1500)])) };
  const arabic = await call("bpt_chunk_work", { book: "TIT", chapter: 12, kind: "tn", limit: 25 });
  assert(arabic.data.next_cursor !== null && arabic.data.rows.every((r) => r.en_note.length === 1500), "Arabic notes with English sources page early");
  assert(byteLength(arabic.data) < PAGE_BYTE_BUDGET + 2000, `the page with en_note stays under the byte budget (${byteLength(arabic.data)} bytes)`);

  // The first row is always admitted, so it must fit on its own: a 6,000-char
  // 3-byte-script note plus a 6,000-char English note full of quotes (two
  // bytes each once JSON-escaped) is ~30 KB before fitting.
  srcStub = { ok: true, source: "unfoldingWord/en_tn", notes: new Map([["r900", '"'.repeat(ROW_TEXT_CAP)], ["r901", "short"]]) };
  const wide = await call("bpt_chunk_work", { book: "TIT", chapter: 13, kind: "tn", limit: 25 });
  const first = wide.data.rows[0];
  assert(first.id === "r900" && first.note.length === ROW_TEXT_CAP, "the row's own note is left whole");
  assert(first.en_truncated === true && first.en_note.length > 0 && first.en_note.length < ROW_TEXT_CAP, "en_note is shortened to fit and marked en_truncated");
  assert(byteLength(first) <= PAGE_BYTE_BUDGET, `the first row fits the budget on its own (${byteLength(first)} bytes)`);
  assert(byteLength(wide.data) < PAGE_BYTE_BUDGET + 2000 && byteLength(wide.data) < 32000, `the page stays under budget plus envelope and under 32 KB (${byteLength(wide.data)} bytes)`);
  assert(!/no English note/.test(wide.data.note ?? ""), "a shortened en_note is not reported as missing");

  srcStub = { ok: true, source: "unfoldingWord/en_tn", notes: new Map([["r950", "English"]]) };
  const over = await call("bpt_chunk_work", { book: "TIT", chapter: 14, kind: "tn" });
  assert(over.data.rows[0].en_note === null && over.data.rows[0].en_truncated === true, "a row over budget on its own note drops en_note to null, marked en_truncated");
  assert(over.data.rows[0].note.length === ROW_TEXT_CAP, "and still keeps its own note");
  srcStub = NO_SOURCE;
}

console.log("[tools] bpt_get_row English source note");
{
  // Longer than chunk_work's cap: get_row is where a reviewer reads it whole.
  const longEn = "e".repeat(ROW_TEXT_CAP + 500);
  srcStub = { ok: true, source: "unfoldingWord/en_tn", notes: new Map([["r5", longEn]]) };
  srcCalls.length = 0;
  const full = await call("bpt_get_row", { book: "TIT", kind: "tn", id: "r5" });
  assert(!full.isError && srcCalls.length === 1 && srcCalls[0].ws === "bsoj" && srcCalls[0].book === "TIT", "get_row reads the English source once, for the link's workspace and book");
  assert(srcCalls[0].chapter === 1, "get_row reads the English source for the row's own chapter (#691)");
  assert(full.data.en_note === longEn && full.data.en_truncated === undefined, "get_row returns the whole English note, past ROW_TEXT_CAP");
  assert(full.data.en_source === "unfoldingWord/en_tn" && full.data.en_note_status === null, "get_row names the source and has nothing to explain");
  assert(full.data.note === "n".repeat(40) && full.data.id === "r5", "the row's own note is untouched by the English fields");

  srcStub = { ok: true, source: "unfoldingWord/en_tn", notes: new Map([["r6", "other"]]) };
  const unmatched = await call("bpt_get_row", { book: "TIT", kind: "tn", id: "r5" });
  assert(unmatched.data.en_note === null && /no English note with the same id/.test(unmatched.data.en_note_status), "an id with no English row gets en_note null and a status saying why");
  assert(unmatched.data.en_source === "unfoldingWord/en_tn", "and still names the source it looked in");

  srcStub = { ok: false, reason: "Could not read the English notes tn_TIT.tsv from unfoldingWord/en_tn (HTTP 503)." };
  const down = await call("bpt_get_row", { book: "TIT", kind: "tn", id: "r5" });
  assert(!down.isError && down.data.id === "r5", "an unreadable source never fails get_row");
  assert(down.data.en_note === null && down.data.en_source === null && /HTTP 503/.test(down.data.en_note_status), "source down: en_note null, en_source null, the status says why");

  srcCalls.length = 0;
  const tq = await call("bpt_get_row", { book: "TIT", kind: "tq", id: "q703" });
  assert(!tq.isError && tq.data.id === "q703", "get_row reads a question");
  assert(srcCalls.length === 0 && tq.data.en_note === undefined && tq.data.en_source === undefined && tq.data.en_note_status === undefined, "questions get no English fields and no source read");

  // A pathological English note: 100,000 quotes, two bytes each once
  // JSON-escaped, next to a long own note in a 3-byte script.
  srcStub = { ok: true, source: "unfoldingWord/en_tn", notes: new Map([["r961", '"'.repeat(100_000)]]) };
  const huge = await call("bpt_get_row", { book: "TIT", kind: "tn", id: "r961" });
  assert(!huge.isError && huge.data.note.length === 4000, "the row's own note is left whole");
  assert(huge.data.en_truncated === true && huge.data.en_note.length > 0 && huge.data.en_note.length < 100_000, "a huge English note is cut and marked en_truncated");
  assert(/cut/.test(huge.data.en_note_status) && /32 KB/.test(huge.data.en_note_status), "the status says the English note was cut for the size limit");
  // mcp.ts JSON-encodes the result into content[0].text and then encodes the
  // envelope again, so get_row measures the doubly encoded string.
  const wire = (v) => byteLength(JSON.stringify(v));
  assert(wire(huge.data) <= GET_ROW_BYTE_BUDGET && wire(huge.data) < 32000, `the get_row response stays within the budget on the wire (${wire(huge.data)} bytes)`);

  // Own note over the budget on its own: the bare row, unchanged, since the
  // budget is under the real cap and any added byte could tip it over.
  srcStub = { ok: true, source: "unfoldingWord/en_tn", notes: new Map([["r962", "English"]]) };
  srcCalls.length = 0;
  const over = await call("bpt_get_row", { book: "TIT", kind: "tn", id: "r962" });
  assert(!over.isError && over.data.note.length === 6000, "a row over budget on its own keeps its own note whole");
  assert(Object.keys(over.data).every((k) => !k.startsWith("en_")) && srcCalls.length === 0, "and gets no en_* fields and no source read");

  // A row just under the budget on its own: adding the English fields must
  // not push it over, whichever way the English note is missing.
  const EN_KEYS = ["en_note", "en_source", "en_note_status", "en_truncated"];
  const bare = (d) => Object.fromEntries(Object.entries(d).filter(([k]) => !EN_KEYS.includes(k)));
  nearRow = tnRow(963, 1, 1000, "a");
  srcStub = { ok: false, reason: "probe" };
  const probe = await call("bpt_get_row", { book: "TIT", kind: "tn", id: "r963" });
  const nearLen = 1000 + (GET_ROW_BYTE_BUDGET - 20 - wire(bare(probe.data)));
  nearRow = tnRow(963, 1, nearLen, "a");
  srcStub = { ok: false, reason: "Could not read the English notes tn_TIT.tsv from unfoldingWord/en_tn (HTTP 503)." };
  const nearDown = await call("bpt_get_row", { book: "TIT", kind: "tn", id: "r963" });
  assert(wire(bare(nearDown.data)) === GET_ROW_BYTE_BUDGET - 20, "the near-budget row is 20 bytes under on its own");
  assert(!nearDown.isError && nearDown.data.note.length === nearLen && nearDown.data.en_note == null, "source down near the budget: own note whole, no English note");
  assert(wire(nearDown.data) <= GET_ROW_BYTE_BUDGET, `source down near the budget stays within it (${wire(nearDown.data)} bytes)`);
  srcStub = { ok: true, source: "unfoldingWord/en_tn", notes: new Map([["r6", "other"]]) };
  const nearMissing = await call("bpt_get_row", { book: "TIT", kind: "tn", id: "r963" });
  assert(!nearMissing.isError && nearMissing.data.note.length === nearLen && nearMissing.data.en_note == null, "missing id near the budget: own note whole, no English note");
  assert(wire(nearMissing.data) <= GET_ROW_BYTE_BUDGET, `missing id near the budget stays within it (${wire(nearMissing.data)} bytes)`);
  srcStub = { ok: true, source: "unfoldingWord/en_tn", notes: new Map([["r963", "English ".repeat(500)]]) };
  const nearFound = await call("bpt_get_row", { book: "TIT", kind: "tn", id: "r963" });
  assert(!nearFound.isError && nearFound.data.note.length === nearLen && wire(nearFound.data) <= GET_ROW_BYTE_BUDGET, `a matching English note near the budget stays within it (${wire(nearFound.data)} bytes)`);

  // With room for a short status but not the long one, the short one is used.
  nearRow = tnRow(963, 1, nearLen - 100, "a");
  srcStub = { ok: false, reason: "x".repeat(500) };
  const roomy = await call("bpt_get_row", { book: "TIT", kind: "tn", id: "r963" });
  assert(roomy.data.en_note === null && typeof roomy.data.en_note_status === "string" && roomy.data.en_note_status.length < 100, "a short status replaces a long one that would not fit");
  assert(wire(roomy.data) <= GET_ROW_BYTE_BUDGET, `and the response stays within the budget (${wire(roomy.data)} bytes)`);

  // An English note that fits whole with a null status, but not with the long
  // "cut" status counted in, comes back whole: the status is not a reason to cut.
  const tight = "E".repeat(200);
  const probeBare = bare(probe.data);
  const enBytes = wire({ ...probeBare, en_note: tight, en_source: "unfoldingWord/en_tn", en_note_status: null }) - wire(probeBare);
  nearRow = tnRow(963, 1, nearLen + 15 - enBytes, "a");
  srcStub = { ok: true, source: "unfoldingWord/en_tn", notes: new Map([["r963", tight]]) };
  const snug = await call("bpt_get_row", { book: "TIT", kind: "tn", id: "r963" });
  assert(wire(snug.data) === GET_ROW_BYTE_BUDGET - 5, `the whole English note leaves 5 bytes of the budget (${wire(snug.data)} bytes)`);
  assert(snug.data.en_note === tight && snug.data.en_truncated === undefined && snug.data.en_note_status === null, "a note that fits whole without the cut status is returned whole, not cut");
  nearRow = null;
  srcStub = NO_SOURCE;
}

console.log("[sourceNotes] Door43 read, cache and degradation");
{
  const { readSourceNotes, clearSourceNotesCache } = await import("./sourceNotes.ts");
  const { clearProjectConfigCache } = await import("./projectConfig.ts");
  // The project config row, and (#691) this book's tN source overrides:
  // none unless a test passes ranges.
  const envFor = (preset, slug, ranges = []) => ({
    WORKSPACE_SLUG: slug,
    DCS_BASE_URL: "https://door43.test",
    DB: {
      prepare: (sql) =>
        /book_source_overrides/.test(sql)
          ? { bind: () => ({ all: async () => ({ results: ranges }) }) }
          : { first: async () => ({ preset, overrides_json: null }) },
    },
  });
  const realFetch = globalThis.fetch;
  const fetched = [];
  const inits = [];
  let reply = () => new Response("﻿Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n1:1\tab12\t\t\tq\t1\tLine one\\nLine two\r\n1:2\tcd34\t\t\tq\t1\tSecond\n", { status: 200 });
  globalThis.fetch = async (url, init) => {
    fetched.push(String(url));
    inits.push(init);
    return reply();
  };
  const realTimeout = AbortSignal.timeout;
  try {
    clearSourceNotesCache();
    clearProjectConfigCache();
    // The service token is set, as in production; it must not be sent.
    const ml = { ...envFor("en-bible-editor-ml-test", "src-ml"), DCS_SERVICE_TOKEN: "secret-service-token" };
    const a = await readSourceNotes(ml, "TIT", 1);
    assert(a.ok && a.source === "unfoldingWord/en_tn" && fetched[0] === "https://door43.test/unfoldingWord/en_tn/raw/branch/master/tn_TIT.tsv", "reads tn_<BOOK>.tsv from the project's tN source");
    const headers = new Headers(inits[0]?.headers);
    assert(!headers.has("authorization") && !JSON.stringify(inits[0] ?? {}).includes("secret-service-token"), "the fetch is anonymous: no Authorization header, like the web app's");
    assert(inits[0]?.signal instanceof AbortSignal, "the fetch carries a timeout signal");
    assert(a.notes.get("ab12") === "Line one\\nLine two" && a.notes.get("cd34") === "Second" && a.notes.size === 2, "parses past a BOM and CRLF, keyed by ID, \\n escapes kept");
    await readSourceNotes(ml, "TIT", 1);
    assert(fetched.length === 1, "a second read inside the TTL is served from cache");

    reply = () => new Response("nope", { status: 404 });
    const missing = await readSourceNotes(ml, "OBA", 1);
    assert(!missing.ok && /no such file, or the repository is not public/.test(missing.reason), "404 -> not ok; the reason allows for a private repo");
    await readSourceNotes(ml, "OBA", 1);
    assert(fetched.length === 3, "a failure is not cached");

    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    const offline = await readSourceNotes(ml, "JUD", 1);
    assert(!offline.ok && /network error/.test(offline.reason), "network failure -> not ok, never throws");

    // A Door43 that never answers: the real abort path, with the 8 s timeout
    // shortened so the test is quick.
    AbortSignal.timeout = () => realTimeout.call(AbortSignal, 20);
    globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    // Node unrefs AbortSignal.timeout's timer; hold the loop open meanwhile.
    const keepAlive = setTimeout(() => {}, 5_000);
    const hung = await readSourceNotes(ml, "MAL", 1);
    clearTimeout(keepAlive);
    assert(!hung.ok && /did not answer in time/.test(hung.reason), "a hanging fetch times out -> not ok, with a reason");
    AbortSignal.timeout = realTimeout;
    globalThis.fetch = async () => {
      throw new DOMException("aborted", "AbortError");
    };
    const aborted = await readSourceNotes(ml, "HAG", 1);
    assert(!aborted.ok && /did not answer in time/.test(aborted.reason), "an AbortError -> the same timeout reason");

    const authoring = await readSourceNotes(envFor("en-unfoldingword", "src-en"), "TIT", 1);
    assert(!authoring.ok && /English/.test(authoring.reason), "an authoring project has no separate source");

    const broken = { WORKSPACE_SLUG: "src-broken", DB: { prepare: () => { throw new Error("db down"); } } };
    const r = await readSourceNotes(broken, "TIT", 1);
    assert(typeof r.ok === "boolean", "a config read failure still returns a result");
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
    clearSourceNotesCache();
  }
}

console.log("[sourceNotes] per-book / per-chapter tN source overrides (#691)");
{
  const { readSourceNotes, clearSourceNotesCache, noteSourcePlanForClient } = await import("./sourceNotes.ts");
  const { clearProjectConfigCache } = await import("./projectConfig.ts");
  const HEADER = "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n";
  const tsv = (rows) => HEADER + rows.map(([ref, id, note]) => `${ref}\t${id}\t\t\tq\t1\t${note}`).join("\n") + "\n";
  const base = "https://door43.test/unfoldingWord/en_tn/raw/branch/master/tn_ZEC.tsv";
  const other = "https://door43.test/OtherOrg/other_tn/raw/branch/master/tn_ZEC.tsv";
  const third = "https://door43.test/ThirdOrg/third_tn/raw/branch/master/tn_ZEC.tsv";
  const whole = "https://door43.test/WholeOrg/whole_tn/raw/branch/master/tn_ZEC.tsv";
  // Every source carries id "ab12" in chapter 2, with different text, so a
  // read from the wrong repo shows up as the wrong note.
  const files = {
    [base]: tsv([["front:intro", "fr00", "EN front"], ["2:1", "ab12", "EN two"], ["4:1", "cd34", "EN four"], ["5:1", "ef56", "EN five"], ["8:1", "gh78", "EN eight"]]),
    [other]: tsv([["2:1", "ab12", "OTHER two"], ["3:1", "ij90", "OTHER three"], ["4:1", "cd34", "OTHER four"]]),
    [third]: tsv([["8:1", "gh78", "THIRD eight"], ["2:1", "ab12", "THIRD two"]]),
    [whole]: tsv([["2:1", "ab12", "WHOLE two"], ["4:1", "cd34", "WHOLE four"]]),
  };
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    const body = files[String(url)];
    return body ? new Response(body, { status: 200 }) : new Response("nope", { status: 404 });
  };
  const PRESET = "en-bible-editor-ml-test";
  const envFor = (preset, slug, ranges, overrides_json = null) => ({
    WORKSPACE_SLUG: slug,
    DCS_BASE_URL: "https://door43.test",
    DB: {
      prepare: (sql) =>
        /book_source_overrides/.test(sql)
          ? { bind: () => ({ all: async () => ({ results: ranges }) }) }
          : { first: async () => ({ preset, overrides_json }) },
    },
  });
  try {
    clearSourceNotesCache();
    clearProjectConfigCache();
    const ranges = [
      { chapter_start: 1, chapter_end: 3, kind: "dcs", org: "OtherOrg", repo: "other_tn" },
      { chapter_start: 5, chapter_end: 6, kind: "aquifer", org: "aquifer", repo: "arb" },
      { chapter_start: 8, chapter_end: 9, kind: "dcs", org: "ThirdOrg", repo: "third_tn" },
    ];
    const env = envFor(PRESET, "src-ov", ranges);

    const two = await readSourceNotes(env, "ZEC", 2);
    assert(two.ok && two.source === "OtherOrg/other_tn" && fetched.at(-1) === other, "a chapter in a dcs override range reads the override's org/repo");
    assert(two.notes.get("ab12") === "OTHER two", "and matches the override's note for the id, not the project-wide source's");
    assert(two.notes.get("ij90") === "OTHER three" && !two.notes.has("cd34"), "only the override's rows for chapters the override covers count");

    const eight = await readSourceNotes(env, "ZEC", 8);
    assert(eight.ok && eight.source === "ThirdOrg/third_tn" && eight.notes.get("gh78") === "THIRD eight", "a second range in the same book resolves on its own");
    assert(!eight.notes.has("ab12"), "the second range's repo does not answer for the first range's chapters");

    const four = await readSourceNotes(env, "ZEC", 4);
    assert(four.ok && four.source === "unfoldingWord/en_tn" && fetched.at(-1) === base, "a chapter no override covers reads the project-wide source");
    assert(four.notes.get("cd34") === "EN four" && four.notes.get("fr00") === "EN front", "with its own notes");
    assert(!four.notes.has("ab12") && !four.notes.has("gh78"), "but not for chapters a Door43 override takes over");

    const before = fetched.length;
    // Aquifer rows are built on the project's en_tn and matched ones keep its
    // ids, so an Aquifer chapter reads the project-wide source.
    const five = await readSourceNotes(env, "ZEC", 5);
    assert(five.ok && five.source === "unfoldingWord/en_tn" && fetched.length === before, "an Aquifer range reads the project-wide source (from cache here)");
    assert(five.notes.get("ef56") === "EN five", "a matched Aquifer row gets the en_tn note with its id");
    assert(!five.notes.has("mint") && !five.notes.has("ab12"), "an unmatched (minted) id has no note, and an overridden chapter's id still does not answer");

    await readSourceNotes(env, "ZEC", 3);
    assert(fetched.length === before, "the cache is per resolved repo: chapter 3 reuses chapter 2's OtherOrg read");

    const wholeEnv = envFor(PRESET, "src-whole", [{ chapter_start: 0, chapter_end: 999, kind: "dcs", org: "WholeOrg", repo: "whole_tn" }]);
    const w = await readSourceNotes(wholeEnv, "ZEC", 4);
    assert(w.ok && w.source === "WholeOrg/whole_tn" && w.notes.get("cd34") === "WHOLE four", "a whole-book dcs override replaces the project-wide source");

    // An override that only names the project's own repo is not a real
    // override (import treats it the same way): the project-wide source stays.
    const ownEnv = envFor(PRESET, "src-own", [{ chapter_start: 1, chapter_end: 3, kind: "dcs", org: "BibleEditorMLTest", repo: "en_tn" }]);
    const own = await readSourceNotes(ownEnv, "ZEC", 2);
    assert(own.ok && own.source === "unfoldingWord/en_tn" && own.notes.get("ab12") === "EN two", "an override naming the project's own repo is a no-op");

    // A non-ident stored org is never fetched (bookSource.ts re-validates on read).
    const badEnv = envFor(PRESET, "src-bad", [{ chapter_start: 1, chapter_end: 3, kind: "dcs", org: "../evil", repo: "x" }]);
    const bad = await readSourceNotes(badEnv, "ZEC", 2);
    assert(bad.ok && bad.source === "unfoldingWord/en_tn" && !fetched.some((u) => u.includes("evil")), "a stored override that is not a valid org/repo is ignored");

    // The override table unreadable: no guess at the source, and no throw.
    const downEnv = {
      WORKSPACE_SLUG: "src-ovdown",
      DCS_BASE_URL: "https://door43.test",
      DB: {
        prepare: (sql) =>
          /book_source_overrides/.test(sql)
            ? { bind: () => ({ all: async () => { throw new Error("D1 overloaded"); } }) }
            : { first: async () => ({ preset: PRESET, overrides_json: null }) },
      },
    };
    const down = await readSourceNotes(downEnv, "ZEC", 2);
    assert(!down.ok && typeof down.reason === "string", "an unreadable override table is not ok, and never throws");

    // A translation project with no project-wide tN repo: import still reads a
    // dcs override, so the English source note does too.
    const NO_TN = JSON.stringify({ mode: "translation", translationSource: { org: "unfoldingWord", repos: { lit: "en_ult" } } });
    const noBase = envFor(PRESET, "src-nobase", [{ chapter_start: 1, chapter_end: 2, kind: "dcs", org: "OtherOrg", repo: "other_tn" }], NO_TN);
    const nb1 = await readSourceNotes(noBase, "ZEC", 1);
    assert(nb1.ok && nb1.source === "OtherOrg/other_tn" && nb1.notes.get("ab12") === "OTHER two", "no project-wide tN: a chapter in a dcs range still reads the override");
    const nb3 = await readSourceNotes(noBase, "ZEC", 3);
    assert(!nb3.ok && /no English tN source/.test(nb3.reason), "no project-wide tN: a chapter no override covers has no source, with the existing reason");
    const nbPlan = await noteSourcePlanForClient(noBase, "ZEC");
    assert(nbPlan && nbPlan.base === null && nbPlan.ranges.length === 1 && nbPlan.ranges[0].org === "OtherOrg", "the web plan has a null base and the override range");

    const noBaseWhole = envFor(PRESET, "src-nobase-whole", [{ chapter_start: 0, chapter_end: 999, kind: "dcs", org: "WholeOrg", repo: "whole_tn" }], NO_TN);
    const nbw = await readSourceNotes(noBaseWhole, "ZEC", 4);
    assert(nbw.ok && nbw.source === "WholeOrg/whole_tn" && nbw.notes.get("cd34") === "WHOLE four", "no project-wide tN: a whole-book override is read");
    const nbwPlan = await noteSourcePlanForClient(noBaseWhole, "ZEC");
    assert(nbwPlan?.base?.org === "WholeOrg" && nbwPlan.ranges.length === 0, "and the web plan's base is the whole-book override");

    const authoringPlan = await noteSourcePlanForClient(envFor("en-unfoldingword", "src-auth-plan", []), "ZEC");
    assert(authoringPlan === null, "an authoring project gets no plan");

    // tQ (#695): the same plan for the English source question. This mock
    // filters on the bound resource, so a tN range must not leak into the tQ
    // plan. Aquifer is tN-only, so a tQ Aquifer range is dropped.
    const byResource = (slug, rows, overrides_json = null) => ({
      WORKSPACE_SLUG: slug,
      DCS_BASE_URL: "https://door43.test",
      DB: {
        prepare: (sql) =>
          /book_source_overrides/.test(sql)
            ? { bind: (_book, resource) => ({ all: async () => ({ results: rows.filter((r) => r.resource === resource) }) }) }
            : { first: async () => ({ preset: PRESET, overrides_json }) },
      },
    });
    const tqEnv = byResource("src-tq", [
      { resource: "tn", chapter_start: 3, chapter_end: 4, kind: "dcs", org: "OtherOrg", repo: "other_tn" },
      { resource: "tq", chapter_start: 1, chapter_end: 2, kind: "dcs", org: "ru_gl", repo: "ru_tq" },
      { resource: "tq", chapter_start: 5, chapter_end: 6, kind: "aquifer", org: "aquifer", repo: "arb" },
    ]);
    const tqPlan = await noteSourcePlanForClient(tqEnv, "ZEC", "tq");
    assert(tqPlan?.base?.org === "unfoldingWord" && tqPlan.base.repo === "en_tq", "the tQ plan's base is the project-wide tQ repo");
    assert(
      tqPlan.ranges.length === 1 && tqPlan.ranges[0].org === "ru_gl" && tqPlan.ranges[0].repo === "ru_tq" && tqPlan.ranges[0].chapter_start === 1 && tqPlan.ranges[0].chapter_end === 2,
      "the tQ plan carries only the tQ dcs range (no tN range, no Aquifer)",
    );
    const tnPlanSame = await noteSourcePlanForClient(tqEnv, "ZEC");
    assert(tnPlanSame?.base?.repo === "en_tn" && tnPlanSame.ranges.length === 1 && tnPlanSame.ranges[0].org === "OtherOrg", "the tN plan is unchanged and default");

    const tqNone = await noteSourcePlanForClient(byResource("src-tq-none", []), "ZEC", "tq");
    assert(tqNone?.base?.repo === "en_tq" && tqNone.ranges.length === 0, "no tQ override: the project-wide tQ repo, no ranges");

    const tqWhole = await noteSourcePlanForClient(
      byResource("src-tq-whole", [{ resource: "tq", chapter_start: 0, chapter_end: 999, kind: "dcs", org: "ru_gl", repo: "ru_tq" }]),
      "ZEC",
      "tq",
    );
    assert(tqWhole?.base?.org === "ru_gl" && tqWhole.ranges.length === 0, "a whole-book tQ override is the base");
  } finally {
    globalThis.fetch = realFetch;
    clearSourceNotesCache();
  }
}

console.log("[tools] chunks");
{
  const span = (r) => r.data.chunks.map((c) => `${c.start}-${c.end}`).join(",");
  const m = await call("bpt_chunks", { book: "tit", chapter: 5 });
  assert(!m.isError && m.data.book === "TIT" && m.data.lane === "ULT", "markers are read from ULT");
  assert(m.data.split === "ts_markers" && m.data.by === null, "split says the markers made the chunks");
  assert(span(m) === "1-2,3-4,5-6,7-10", `all three marker shapes split; verse 0 ignored; a bridge ends the last chunk (${span(m)})`);
  assert(m.data.chunks.map((c) => `${c.tn}/${c.tq}`).join() === "2/1,1/0,0/0,1/1", "tN/tQ counted per chunk, trashed rows left out");
  assert(m.data.outside_chunks.tn === 1 && m.data.outside_chunks.tq === 0, "the verse-0 intro note is counted outside every chunk");
  assert(calls.at(-1).path === "/api/chapters/TIT/5", "one read of the chapter route");

  const by3 = await call("bpt_chunks", { book: "TIT", chapter: 5, by: 3 });
  assert(by3.data.split === "every_n_verses" && by3.data.by === 3, "by overrides the markers");
  assert(span(by3) === "1-3,4-6,7-10", `every 3 verses, a bridge never split (${span(by3)})`);
  const by1 = await call("bpt_chunks", { book: "TIT", chapter: 5, by: "1" });
  assert(by1.data.chunks.length === 9 && by1.data.chunks.at(-1).start === 9, "by as a numeric string; by 1 keeps the bridge whole");
  const by0 = await call("bpt_chunks", { book: "TIT", chapter: 5, by: 0 });
  assert(by0.isError && /by must be/.test(by0.data.error), "by 0 -> readable error");

  const ust = await call("bpt_chunks", { book: "TIT", chapter: 6 });
  assert(!ust.isError && ust.data.lane === "UST" && span(ust) === "1-2,3-4", "no ULT: UST's markers are used");
  assert(/ULT/.test(ust.data.note), "the note says ULT was not available");

  const src = await call("bpt_chunks", { book: "TIT", chapter: 7 });
  assert(!src.isError && src.data.lane === "UHB" && src.data.split === "whole_chapter", "no target lane and no by: the whole chapter as one chunk");
  assert(span(src) === "1-4" && src.data.chunks[0].tn === 1, "source verses number the chunk, verse 0 left out");
  assert(/by/.test(src.data.note) && /ULT/.test(src.data.note), "the note says why and how to split");
  const srcBy = await call("bpt_chunks", { book: "TIT", chapter: 7, by: 2 });
  assert(srcBy.data.split === "every_n_verses" && span(srcBy) === "1-2,3-4", "no target lane: by still splits");

  const none = await call("bpt_chunks", { book: "TIT", chapter: 8 });
  assert(none.isError && /no verses/.test(none.data.error), "no lane at all -> readable error, no crash");

  const plain = await call("bpt_chunks", { book: "TIT", chapter: 9 });
  assert(plain.data.lane === "ULT" && plain.data.split === "whole_chapter" && span(plain) === "1-5", "ULT without markers: one chunk");
  assert(/no \\ts\\\* markers/.test(plain.data.note), "the note says there are no markers");

  const gap = await call("bpt_chunks", { book: "TIT", chapter: 10 });
  assert(span(gap) === "1-2,3-4,5-7", `chunks cover the chapter with no gaps, out to the last note (${span(gap)})`);
  assert(gap.data.chunks[1].tn === 1 && gap.data.chunks[1].tq === 1, "a note on a verse missing from the lane lands in a chunk");
  assert(gap.data.chunks[2].tn === 1, "a note past the lane's last verse lands in the last chunk");
  assert(gap.data.outside_chunks.tn === 1 && gap.data.outside_chunks.tq === 1, "outside_chunks counts only verse 0");
  const gapBy = await call("bpt_chunks", { book: "TIT", chapter: 10, by: 2 });
  assert(span(gapBy) === "1-2,3-4,5-7", `by counts a missing verse toward n (${span(gapBy)})`);
  assert(gapBy.data.outside_chunks.tn === 1, "by: outside_chunks still only verse 0");

  const missing = await call("bpt_chunks", { book: "TIT", chapter: 99 });
  assert(missing.isError, "missing chapter -> isError");
}

console.log("all mcp tests passed");
