// Unit tests for the chat MCP endpoint (mcp.ts + mcpTools.ts): bearer check
// per workspace, no fallback on an unknown slug, the JSON-RPC envelope, and
// paging that never drops rows past BT Servant's 32 KB tool-result cap.
// The in-process API is stubbed, so no D1 is touched.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/mcp.test.mjs

import { handleMcp, mcpWorkspaceSlug } from "./mcp.ts";
import { PAGE_BYTE_BUDGET, ROW_TEXT_CAP, byteLength } from "./mcpTools.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const TOKEN = "t".repeat(40);
const OTHER = "o".repeat(40);
const WS = { slug: "bsoj", label: "BSOJ", org: "BSOJ", binding: "DB" };

function tnRow(i, verse, noteLen = 40, ch = "n") {
  return {
    id: `r${i}`, book: "TIT", chapter: 1, verse, ref_raw: `1:${verse}`,
    support_reference: "rc://*/ta/man/translate/figs-metaphor", quote: "q", occurrence: 1,
    note: ch.repeat(noteLen), translation_state: "ai_draft", version: 3, latest_source: "ai_pipeline",
    trashed_at: i === 2 ? 1700000000 : null, sort_order: i, draft_meta_json: "{}",
  };
}

const calls = [];
// Mutable so a test can trash a row between two page requests.
let ch1 = Array.from({ length: 30 }, (_v, i) => tnRow(i, 1 + Math.floor(i / 3)));
function deps(overrides = {}) {
  return {
    tokens: JSON.stringify({ bsoj: TOKEN, other: OTHER }),
    findWorkspace: async (slug) => (slug === "bsoj" ? WS : null),
    getJson: async (ws, path) => {
      calls.push({ ws: ws.slug, path });
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
      if (path.startsWith("/api/rows/tn/r5")) return { status: 200, body: tnRow(5, 2) };
      return { status: 404, body: { error: "not_found" } };
    },
    ...overrides,
  };
}

function post(slug, body, { token = TOKEN, method = "POST", raw } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`https://x.test/api/mcp/${slug}`, {
    method,
    headers,
    body: method === "POST" ? (raw ?? JSON.stringify(body)) : undefined,
  });
}

async function rpc(method, params, opts = {}) {
  const res = await handleMcp(post("bsoj", { jsonrpc: "2.0", id: 7, method, params }), "bsoj", deps(opts.deps));
  return { status: res.status, body: await res.json() };
}

async function call(name, args) {
  const { body } = await rpc("tools/call", { name, arguments: args });
  return { isError: body.result?.isError === true, data: JSON.parse(body.result.content[0].text) };
}

console.log("[path] workspace slug from the URL");
assert(mcpWorkspaceSlug("https://x.test/api/mcp/bsoj") === "bsoj", "slug parsed");
assert(mcpWorkspaceSlug("https://x.test/api/mcp/bsoj/") === "bsoj", "trailing slash tolerated");
assert(mcpWorkspaceSlug("https://x.test/api/chapters/TIT") === null, "other paths ignored");

console.log("[auth] bearer per workspace");
{
  const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  let res = await handleMcp(post("bsoj", body, { token: null }), "bsoj", deps());
  assert(res.status === 401, "missing token -> 401");
  res = await handleMcp(post("bsoj", body, { token: OTHER }), "bsoj", deps());
  assert(res.status === 401, "another workspace's token -> 401");
  res = await handleMcp(post("bsoj", body), "bsoj", deps({ tokens: undefined }));
  assert(res.status === 401, "no MCP_SERVICE_TOKENS -> 401");
  res = await handleMcp(post("bsoj", body), "bsoj", deps({ tokens: JSON.stringify({ bsoj: "short" }) }));
  assert(res.status === 401, "a token under 32 chars is never accepted");
  res = await handleMcp(post("other", body, { token: OTHER }), "other", deps());
  assert(res.status === 404, "valid token but unknown workspace -> 404, no fallback");
  res = await handleMcp(post("nope", body, { token: TOKEN }), "nope", deps());
  assert(res.status === 401, "unknown slug without its own token -> 401 (no workspace probing)");
  res = await handleMcp(post("bsoj", null, { method: "GET" }), "bsoj", deps());
  assert(res.status === 405, "GET -> 405");
}

console.log("[jsonrpc] envelope");
{
  let res = await handleMcp(post("bsoj", null, { raw: "{not json" }), "bsoj", deps());
  let body = await res.json();
  assert(body.error?.code === -32700, "parse error -> -32700");
  res = await handleMcp(post("bsoj", { id: 1, method: "tools/list" }), "bsoj", deps());
  body = await res.json();
  assert(body.error?.code === -32600, "missing jsonrpc -> -32600");
  res = await handleMcp(post("bsoj", { jsonrpc: "2.0", method: "notifications/initialized" }), "bsoj", deps());
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
  const bad = await rpc("tools/call", { name: "bpt_nope", arguments: {} });
  assert(bad.body.error?.code === -32602, "unknown tool -> -32602");
}

console.log("[tools] reads");
{
  calls.length = 0;
  const who = await call("bpt_whoami", {});
  assert(who.data.workspace.slug === "bsoj" && who.data.access === "read_only", "whoami names the workspace");
  assert(who.data.workspace.binding === undefined, "whoami does not expose the D1 binding name");

  const status = await call("bpt_package_status", { book: "tit" });
  assert(status.data.book === "TIT", "book code upper-cased");
  assert(status.data.totals.tn === 43 && status.data.totals.tnApproved === 5, "totals summed across chapters");
  assert(calls.every((c) => c.ws === "bsoj"), "every API read ran against the URL's workspace");

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

console.log("all mcp tests passed");
