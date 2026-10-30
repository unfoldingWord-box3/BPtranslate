// MCP endpoint for chat clients (BT Servant first): POST /api/mcp.
//
// Hand-rolled JSON-RPC 2.0, no SDK. BT Servant's default transport is a
// stateless POST of tools/list and tools/call with `Authorization: Bearer
// <token>` (bt-servant-worker src/services/mcp/discovery.ts); initialize and
// ping are answered too so a stock MCP client can connect for testing.
//
// One server for every workspace (issue #676). BT Servant pools every
// registered server's tools for every org, so one server per workspace would
// put two identically named tool sets in front of the bot. Instead the bearer
// token is one secret (MCP_SERVICE_TOKEN), and the workspace comes from the
// reviewer's account link: every tool but bpt_link_account takes the
// session_token, and the link row names the workspace the code was issued in.
// Neither the workspace nor a user is ever a tool argument: the model can
// reach only the projects this user linked, and only as this user. A user
// with several links has one token each; which one the bot sends is the
// mode's bookkeeping, not a permission boundary.
//
// Auth: this runs from the fetch wrapper in index.ts BEFORE the cookie-based
// workspace swap and before any Hono middleware, so no cookie, CSRF token or
// X-Workspace header is involved. A link whose workspace no longer exists
// counts as no link, never a fallback to the first workspace.

import { TOOLS, ToolInputError, type LinkClaim, type McpSession, type ToolContext } from "./mcpTools.ts";

export const MCP_PATH = "/api/mcp";
const PROTOCOL_VERSION = "2025-03-26";
const MAX_BODY_BYTES = 64 * 1024;

export interface McpDeps {
  // The MCP_SERVICE_TOKEN secret: the one bearer BT Servant presents.
  token: string | undefined;
  // Session token -> its workspace, user and role, or null when the token is
  // not a live link or its workspace is gone.
  resolveSession: (token: string) => Promise<McpSession | null>;
  claimLink: (code: string) => Promise<LinkClaim>;
}

export function isMcpPath(url: string): boolean {
  const path = new URL(url).pathname;
  return path === MCP_PATH || path === `${MCP_PATH}/`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Constant-time for equal lengths; a length mismatch returns early, which
// reveals only the length of a random token.
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handleMcp(request: Request, deps: McpDeps): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  const expected = deps.token && deps.token.length >= 32 ? deps.token : null;
  const auth = request.headers.get("authorization") ?? "";
  const presented = /^bearer /i.test(auth) ? auth.slice(7).trim() : "";
  if (!expected || !presented || !sameToken(presented, expected)) {
    return json({ error: "unauthorized" }, 401);
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  const text = declared > MAX_BODY_BYTES ? "" : await request.text();
  if (declared > MAX_BODY_BYTES || new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413);
  }
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const ctx: ToolContext = { session: deps.resolveSession, claimLink: deps.claimLink };
  const reply = await dispatch(msg, ctx);
  // Notifications get no body.
  return reply === null ? new Response(null, { status: 202 }) : json(reply);
}

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function isRpcRequest(m: unknown): m is RpcRequest {
  if (!m || typeof m !== "object" || Array.isArray(m)) return false;
  const r = m as Record<string, unknown>;
  return r.jsonrpc === "2.0" && typeof r.method === "string";
}

export async function dispatch(msg: unknown, ctx: ToolContext): Promise<unknown | null> {
  if (!isRpcRequest(msg)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  const id = msg.id ?? null;
  if (msg.id === undefined) return null; // notification, e.g. notifications/initialized
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "bptranslate", version: "0.1.0" },
        instructions:
          "BPtranslate language projects. Every tool except bpt_link_account needs the session_token that bpt_link_account returned for this user; the token decides which project is read. bpt_edit_row and bpt_approve save a reviewer's decision on one row, and need the version (bpt_approve: and the state) that row had when the reviewer was shown it. bpt_templates_for_row, bpt_edit_template and bpt_approve_template change the wording future AI drafts start from, pinned to the version the reviewer was shown.",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const name = msg.params?.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return fail(-32602, `Unknown tool: ${String(name)}`);
      const args = msg.params?.arguments ?? {};
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return fail(-32602, "arguments must be an object");
      }
      try {
        const result = await tool.run(args as Record<string, unknown>, ctx);
        return ok({ content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (e) {
        // Tool errors go back as a result the model can read and act on
        // (BT Servant passes the text through), not as a protocol error.
        const message = e instanceof ToolInputError ? e.message : "Internal error reading BPtranslate";
        if (!(e instanceof ToolInputError)) {
          console.error("mcp tool failed", tool.name, e instanceof Error ? (e.stack ?? e.message) : String(e));
        }
        return ok({ content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}
