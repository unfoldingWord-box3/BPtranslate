// MCP endpoint for chat clients (BT Servant first): POST /api/mcp/<workspace>.
//
// Hand-rolled JSON-RPC 2.0, no SDK. BT Servant's default transport is a
// stateless POST of tools/list and tools/call with `Authorization: Bearer
// <token>` (bt-servant-worker src/services/mcp/discovery.ts); initialize and
// ping are answered too so a stock MCP client can connect for testing.
//
// Auth and workspace: this runs from the fetch wrapper in index.ts BEFORE the
// cookie-based workspace swap and before any Hono middleware, so no cookie,
// CSRF token or X-Workspace header is involved. The workspace comes from the
// URL and the token is per workspace (MCP_SERVICE_TOKENS, a JSON map of
// slug -> token, set as a secret). BT Servant registers one server per
// language project. Neither the workspace nor a user is ever a tool argument,
// so the model cannot pick which project or person it acts as.
//
// Unlike the cookie path, an unknown slug is a 404, never a fallback to the
// first workspace: a wrong slug must not read another org's database.

import { TOOLS, ToolInputError, type ToolContext } from "./mcpTools.ts";

export const MCP_PATH_PREFIX = "/api/mcp/";
const PROTOCOL_VERSION = "2025-03-26";
const MAX_BODY_BYTES = 64 * 1024;

export interface McpWorkspace {
  slug: string;
  label: string;
  org: string;
}

export interface McpDeps {
  // JSON map of workspace slug -> service token (the MCP_SERVICE_TOKENS secret).
  tokens: string | undefined;
  // Exact-match workspace lookup; null when the slug is not a workspace.
  findWorkspace: (slug: string) => Promise<McpWorkspace | null>;
  // In-process GET against the given workspace's env.
  getJson: (ws: McpWorkspace, path: string) => Promise<{ status: number; body: unknown }>;
}

// Returns the workspace slug when the request is for the MCP endpoint, else null.
export function mcpWorkspaceSlug(url: string): string | null {
  const path = new URL(url).pathname;
  if (!path.startsWith(MCP_PATH_PREFIX)) return null;
  const slug = path.slice(MCP_PATH_PREFIX.length).replace(/\/$/, "");
  return slug;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tokenFor(tokens: string | undefined, slug: string): string | null {
  if (!tokens) return null;
  try {
    const map = JSON.parse(tokens) as Record<string, unknown>;
    const t = map[slug];
    return typeof t === "string" && t.length >= 32 ? t : null;
  } catch {
    console.error("MCP_SERVICE_TOKENS is not valid JSON");
    return null;
  }
}

// Constant-time for equal lengths; a length mismatch returns early, which
// reveals only the length of a random token.
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handleMcp(request: Request, slug: string, deps: McpDeps): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  // Token first, so an unauthenticated caller learns nothing about which
  // workspaces exist.
  const expected = tokenFor(deps.tokens, slug);
  const auth = request.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!expected || !presented || !sameToken(presented, expected)) {
    return json({ error: "unauthorized" }, 401);
  }
  const ws = await deps.findWorkspace(slug);
  if (!ws) return json({ error: "unknown_workspace" }, 404);

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413);
  }
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const ctx: ToolContext = {
    workspace: { slug: ws.slug, label: ws.label, org: ws.org },
    getJson: (path) => deps.getJson(ws, path),
  };
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
        instructions: `BPtranslate language project "${ctx.workspace.label}". Read-only for now.`,
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
