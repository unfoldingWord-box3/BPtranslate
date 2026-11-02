import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, request as apiRequest, type APIRequestContext } from "@playwright/test";
import { fetchChapter, gotoVerse, mintToken, newUserContext, noteTextarea, saveNote, waitForServerNote } from "./helpers";

// Honor BE_BASE_URL so the suite runs on a relocated port (mirrors s8).
const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";

// Issue #670 part (a): a web edit and a chat edit race on one note. The chat
// reviewer was shown version N; a translator then saves the same note in the
// browser. The chat's bpt_edit_row (still pinned to N) must come back as a
// conflict carrying both the reviewer's text and the web text at N+1, and the
// web text must survive.
//
// The chat side needs the MCP bearer: BE_MCP_TOKEN, else MCP_SERVICE_TOKEN
// from api/.dev.vars (api/.dev.vars.example carries a placeholder, which CI
// copies). Without either, the endpoint answers 401 and the test is skipped.
function mcpToken(): string | null {
  if (process.env.BE_MCP_TOKEN) return process.env.BE_MCP_TOKEN;
  try {
    const vars = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "api", ".dev.vars"), "utf8");
    return /^MCP_SERVICE_TOKEN=(.+)$/m.exec(vars)?.[1].trim() || null;
  } catch {
    return null;
  }
}

async function tool(ctx: APIRequestContext, bearer: string, name: string, args: Record<string, unknown>) {
  const res = await ctx.post("/api/mcp", {
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(res.status(), `${name} HTTP status`).toBe(200);
  const reply = await res.json();
  return { isError: reply.result?.isError === true, data: JSON.parse(reply.result.content[0].text) };
}

test("web edit vs chat edit on one note: the chat gets a conflict with both versions", async ({ browser }) => {
  const bearer = mcpToken();
  test.skip(!bearer || bearer.length < 32, "no MCP_SERVICE_TOKEN (32+ chars) for the local worker");

  // Link a chat session for "chatreviewer" (dev-minted users are admins, which
  // chat caps at editor).
  const chat = await apiRequest.newContext({ baseURL: BASE });
  const reviewer = await mintToken(chat, "chatreviewer");
  const codeRes = await chat.post("/api/chat-links/code", { headers: { "x-csrf-token": reviewer.csrf } });
  expect(codeRes.ok(), await codeRes.text()).toBe(true);
  const { code } = await codeRes.json();
  const link = await tool(chat, bearer!, "bpt_link_account", { code });
  expect(link.isError, JSON.stringify(link.data)).toBe(false);
  const session_token = link.data.session_token as string;

  // The chat shows the reviewer one note, at version N.
  const chapter = await fetchChapter(chat, reviewer.token, "ZEC", 6);
  const target = chapter.tn.find((r) => r.verse === 1)!;
  expect(target, "expected a TN row on ZEC 6:1").toBeTruthy();
  const shown = await tool(chat, bearer!, "bpt_get_row", { session_token, book: "ZEC", kind: "tn", id: target.id });
  expect(shown.isError, JSON.stringify(shown.data)).toBe(false);
  const shownVersion = shown.data.version as number;

  // A translator saves the same note in the web app.
  const { context: webCtx } = await newUserContext(browser, "webtranslator");
  const web = await webCtx.newPage();
  await gotoVerse(web, "ZEC", 6, target.verse);
  const webText = `WEB ${Date.now()}`;
  await noteTextarea(web, target.id).fill(webText);
  await saveNote(web, target.id);
  const landed = await waitForServerNote(chat, reviewer.token, "ZEC", 6, target.id, (n) => n === webText);
  expect(landed.version).toBe(shownVersion + 1);

  // The chat saves the reviewer's correction against the version it showed.
  const chatText = `CHAT ${Date.now()}`;
  const edit = await tool(chat, bearer!, "bpt_edit_row", {
    session_token, book: "ZEC", kind: "tn", id: target.id, version: shownVersion, note: chatText,
  });
  expect(edit.isError, JSON.stringify(edit.data)).toBe(false);
  expect(edit.data.status).toBe("conflict");
  expect(edit.data.your_text).toEqual({ note: chatText });
  expect(edit.data.current.note).toBe(webText);
  expect(edit.data.current.version).toBe(shownVersion + 1);

  // The web text stands.
  const after = await fetchChapter(chat, reviewer.token, "ZEC", 6);
  expect(after.tn.find((r) => r.id === target.id)!.note).toBe(webText);

  await webCtx.close();
  await chat.dispose();
});
