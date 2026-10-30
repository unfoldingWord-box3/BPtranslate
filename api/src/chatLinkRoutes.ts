// Web routes for chat assistant links (issue #669; logic in chatLinks.ts).
// A signed-in user gets a one-time code for the workspace they are in, sees
// their live links, and revokes one. Each route acts on the caller's own links
// only. Viewers may link too (#676): the link is how the chat knows which
// workspace to read, and the MCP write tools check for editor on every call.
// Both writes are in viewerGuard.ts's VIEWER_WRITABLE list.
import { Hono } from "hono";
import type { Env } from "./index";
import { requireAuth, currentUserId } from "./auth.ts";
import { issueCode, listLinks, revokeLink, CODE_TTL_SECONDS } from "./chatLinks.ts";

export const chatLinkRoutes = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

chatLinkRoutes.post("/code", requireAuth, async (c) => {
  const userId = currentUserId(c)!;
  const workspace = c.env.WORKSPACE_SLUG ?? "default";
  const { code, expiresAt } = await issueCode(c.env, userId, workspace);
  return c.json({ code, expiresAt, ttlSeconds: CODE_TTL_SECONDS, workspace });
});

chatLinkRoutes.get("/", requireAuth, async (c) => {
  return c.json({ links: await listLinks(c.env, currentUserId(c)!) });
});

chatLinkRoutes.delete("/:id", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) return c.json({ error: "invalid_id" }, 400);
  if (!(await revokeLink(c.env, currentUserId(c)!, id))) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});
