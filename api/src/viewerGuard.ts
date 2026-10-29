// Global viewer read-only gate — defense-in-depth behind the per-route
// requireEditor / requireAdmin guards.
//
// A "viewer" (DCS org member who isn't on the BE-Admins / BE-Editors teams)
// may log in and read everything, but must never mutate content state. Every
// content-write route already carries requireEditor/requireAdmin; this
// middleware is the backstop so a future write route added WITHOUT a
// per-route guard fails closed for viewers instead of silently becoming
// viewer-writable.
//
// Scope rules:
// - Registered on "/api/*" only (index.ts) — non-API paths keep their normal
//   SPA/asset fallthrough for every caller, so a viewer's response never
//   diverges from anyone else's outside the API surface.
// - Only state-changing methods are gated; reads stay untouched (they are
//   deliberately unauthenticated — public-export destiny).
// - Fail closed on role: only "admin" and "editor" pass. A viewer — or any
//   unknown/future role value — is blocked. Unauthenticated requests (no
//   userId) pass through unchanged so each route's own requireAuth /
//   requireEditor keeps deciding 401 vs 403 exactly as before (and the
//   frontend's silent-refresh-on-401 flow keeps working).
// - Self-scoped, per-user writes are allowlisted by EXACT method + path
//   pattern, not by router prefix — a future unguarded write route added
//   under /api/users/, /api/workspaces/, or /api/alerts/ must be added here
//   deliberately or it fails closed. The one prefix exemption is /api/auth/:
//   that router is entirely session lifecycle (start/callback are GETs;
//   refresh/logout act only on the caller's own session; dev mint is
//   DEV_AUTH_ENABLED + localhost gated) and viewers must be able to hold a
//   session.
import type { Context, MiddlewareHandler } from "hono";
import { currentUserId, currentUserRole, isSuperAdmin } from "./auth.ts";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Exact self-scoped write endpoints a viewer may call. Nothing here mutates
// shared project/content rows:
// - own reading position (auth.ts updateLastLocation)
// - workspace switch (workspaceRoutes.ts — per-user cookie + role re-mint)
// - dismiss own banner alert (alerts.ts — username-scoped UPDATE)
// - own chat link: get a code, revoke a link (chatLinkRoutes.ts — user-scoped
//   rows in the shared DB; the chat itself only lets editors save)
const VIEWER_WRITABLE: Array<{ method: string; pattern: RegExp }> = [
  { method: "PUT", pattern: /^\/api\/users\/me\/location$/ },
  { method: "POST", pattern: /^\/api\/workspaces\/[A-Za-z0-9._-]+$/ },
  { method: "POST", pattern: /^\/api\/alerts\/\d+\/dismiss$/ },
  { method: "POST", pattern: /^\/api\/chat-links\/code$/ },
  { method: "DELETE", pattern: /^\/api\/chat-links\/\d+$/ },
];

export function isViewerWritable(method: string, path: string): boolean {
  if (path.startsWith("/api/auth/")) return true;
  return VIEWER_WRITABLE.some((e) => e.method === method && e.pattern.test(path));
}

export const blockViewerWrites: MiddlewareHandler = async (c: Context, next) => {
  const method = c.req.method.toUpperCase();
  if (!WRITE_METHODS.has(method)) return next();
  if (currentUserId(c) === null) return next(); // anonymous → per-route 401
  const role = currentUserRole(c);
  if (role === "admin" || role === "editor") return next();
  // Super admins are privileged everywhere and manage super-admin-gated routes
  // (e.g. the spare-pool endpoints in workspaceRoutes.ts) that gate on
  // isSuperAdmin, NOT on the JWT role claim. They normally mint as role=admin
  // and pass above, but a stale viewer-role token (e.g. added to SUPER_ADMINS
  // after minting, before refresh) must not be blocked here ahead of the
  // route's own super-admin gate. isSuperAdmin never grants write access to a
  // non-super-admin, so this doesn't widen the viewer surface.
  const username = c.get("username") as string | undefined;
  if (username && isSuperAdmin(c.env, username)) return next();
  if (isViewerWritable(method, c.req.path)) return next();
  return c.json({ error: "forbidden", reason: "viewer_read_only" }, 403);
};
