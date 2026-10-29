// Unit tests for the chat MCP endpoint (mcp.ts + mcpTools.ts): one bearer for
// every workspace, the account link choosing the workspace (and nothing read
// without one), the JSON-RPC envelope, and paging that never drops rows past
// BT Servant's 32 KB tool-result cap. The in-process API is stubbed, so no D1
// is touched.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/mcp.test.mjs

import { handleMcp, isMcpPath } from "./mcp.ts";
import { PAGE_BYTE_BUDGET, ROW_TEXT_CAP, byteLength, principalFrom, readerFrom } from "./mcpTools.ts";

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

const calls = [];
// Mutable so a test can trash a row between two page requests.
let ch1 = Array.from({ length: 30 }, (_v, i) => tnRow(i, 1 + Math.floor(i / 3)));
// Stands in for the routes, per workspace: mltest holds only OBA.
async function apiFor(ws, path) {
      calls.push({ ws: ws.slug, path });
      if (ws.slug === "mltest") {
        if (path === "/api/books") return { status: 200, body: { books: [{ book: "OBA", imported_at: 1 }] } };
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
      if (path.startsWith("/api/rows/tn/r5")) return { status: 200, body: tnRow(5, 2) };
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
function sessionFor(token) {
  const l = LINKS[token];
  if (!l || !l.ws) return null;
  return { workspace: l.ws, principal: l.principal, getJson: (path) => apiFor(l.ws, path) };
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

console.log("all mcp tests passed");
