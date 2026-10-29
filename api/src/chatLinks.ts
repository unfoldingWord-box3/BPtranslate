// Chat assistant account links (issue #669, migration 0075).
//
// The pilot bridge until BT Servant forwards a signed user identity: a
// reviewer signed into the web app gets a one-time code, types it into the
// chat, and the MCP tool bpt_link_account trades it for a session token. The
// bot keeps the token in that user's BT Servant memory and sends it back as
// `session_token` on every call that acts as a person. BPtranslate re-reads
// the user's role from its own tables on every call, so the model never
// chooses who it acts as; it can only present a secret it was given.
//
// Limits, by design:
// - a link is bound to one workspace and refused on any other MCP URL;
// - tokens expire after 30 days and are revocable from the web app;
// - chat never gets more than editor rights, even for an admin (no export,
//   no admin sweeps from a phone);
// - only SHA-256 hashes are stored.
//
// Known exposure: the token is in the bot's memory (BT Servant admins can read
// user memory) and in BT Servant's console log of the link call's result.
// Revoking the link is the remedy. When BT Servant forwards identity, links
// move onto that and tokens go away.

import type { Env } from "./index";
import { effectiveRole, maybeResyncTeamRole, type Role } from "./auth.ts";
import { sharedDb } from "./workspaces.ts";

export const CODE_TTL_SECONDS = 10 * 60;
export const LINK_TTL_SECONDS = 30 * 24 * 60 * 60;
// No 0/O or 1/I, so a code read off a screen and typed on a phone survives.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
// last_used_at is for the web app's link list, not security; skip the write
// when it was bumped recently.
const LAST_USED_GRANULARITY = 5 * 60;

export interface ChatPrincipal {
  userId: number;
  username: string;
  // The user's role in this workspace, capped at editor for chat.
  role: Role | null;
  linkId: number;
}

const now = () => Math.floor(Date.now() / 1000);

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Codes are shown as ABCD-EFGH; people may type them with spaces, a dash or
// in lower case.
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "");
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  // 256 is a multiple of 32, so the modulo has no bias.
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `bpt_${b64}`;
}

function chatRole(role: Role | null): Role | null {
  return role === "admin" ? "editor" : role;
}

// Issues a fresh code for this user in this workspace. Any earlier unclaimed
// code of theirs for the same workspace stops working, so only the newest
// code on screen is live. Codes older than a day, claimed or not, are purged
// here too; the claim is recorded on the chat_links row.
export async function issueCode(env: Env, userId: number, workspaceSlug: string) {
  const db = sharedDb(env);
  const code = randomCode();
  const t = now();
  const expiresAt = t + CODE_TTL_SECONDS;
  await db
    .prepare(
      `DELETE FROM chat_link_codes
        WHERE (user_id = ?1 AND workspace_slug = ?2 AND claimed_at IS NULL) OR expires_at < ?3`,
    )
    .bind(userId, workspaceSlug, t - 24 * 60 * 60)
    .run();
  await db
    .prepare(
      `INSERT INTO chat_link_codes (code_hash, user_id, workspace_slug, expires_at) VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(await sha256(code), userId, workspaceSlug, expiresAt)
    .run();
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
}

export type ClaimResult =
  | { ok: true; token: string; expiresAt: number; principal: ChatPrincipal }
  | { ok: false };

// Trades a code for a session token. Single use: the UPDATE only matches an
// unclaimed, unexpired code for this workspace, so two racing claims cannot
// both win. Every failure looks the same to the caller.
export async function claimCode(env: Env, rawCode: string, workspaceSlug: string): Promise<ClaimResult> {
  const code = normalizeCode(rawCode);
  if (code.length !== CODE_LENGTH) return { ok: false };
  const db = sharedDb(env);
  const codeHash = await sha256(code);
  const t = now();
  const claimed = await db
    .prepare(
      `UPDATE chat_link_codes SET claimed_at = ?1
        WHERE code_hash = ?2 AND claimed_at IS NULL AND expires_at > ?1 AND workspace_slug = ?3`,
    )
    .bind(t, codeHash, workspaceSlug)
    .run();
  if (!claimed.meta?.changes) return { ok: false };
  const row = await db
    .prepare(
      `SELECT c.user_id AS userId, u.dcs_username AS username
         FROM chat_link_codes c JOIN users u ON u.id = c.user_id
        WHERE c.code_hash = ?1`,
    )
    .bind(codeHash)
    .first<{ userId: number; username: string }>();
  if (!row) return { ok: false };
  const token = randomToken();
  const expiresAt = t + LINK_TTL_SECONDS;
  await db
    .prepare(
      `INSERT INTO chat_links (token_hash, user_id, workspace_slug, expires_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(await sha256(token), row.userId, workspaceSlug, expiresAt, t)
    .run();
  const link = await db
    .prepare(`SELECT id FROM chat_links WHERE token_hash = ?1`)
    .bind(await sha256(token))
    .first<{ id: number }>();
  return {
    ok: true,
    token,
    expiresAt,
    principal: {
      userId: row.userId,
      username: row.username,
      role: chatRole(await effectiveRole(env, row.username)),
      linkId: link?.id ?? 0,
    },
  };
}

// Looks up who a session token belongs to, in this workspace. `env` must be
// the workspace's env (workspaceEnv), because the role is read from its
// user_roles table on every call.
export async function resolveToken(
  env: Env,
  token: string,
  workspaceSlug: string,
): Promise<ChatPrincipal | null> {
  if (!token.startsWith("bpt_") || token.length > 100) return null;
  const db = sharedDb(env);
  const row = await db
    .prepare(
      `SELECT l.id, l.user_id AS userId, l.workspace_slug AS ws, l.expires_at AS expiresAt,
              l.revoked_at AS revokedAt, l.last_used_at AS lastUsedAt, u.dcs_username AS username
         FROM chat_links l JOIN users u ON u.id = l.user_id
        WHERE l.token_hash = ?1`,
    )
    .bind(await sha256(token))
    .first<{
      id: number;
      userId: number;
      ws: string;
      expiresAt: number;
      revokedAt: number | null;
      lastUsedAt: number | null;
      username: string;
    }>();
  const t = now();
  if (!row || row.revokedAt || row.expiresAt <= t || row.ws !== workspaceSlug) return null;
  if (!row.lastUsedAt || t - row.lastUsedAt > LAST_USED_GRANULARITY) {
    // Bookkeeping only; a failed write must not fail the caller's request.
    try {
      await db.prepare(`UPDATE chat_links SET last_used_at = ?1 WHERE id = ?2`).bind(t, row.id).run();
    } catch (e) {
      console.warn("chat link last_used_at write failed", e instanceof Error ? e.message : String(e));
    }
  }
  // Same best-effort Door43 team re-check the web app runs on session
  // refresh, so removing someone from the team reaches chat-only users too.
  await maybeResyncTeamRole(env, row.username);
  return {
    userId: row.userId,
    username: row.username,
    role: chatRole(await effectiveRole(env, row.username)),
    linkId: row.id,
  };
}

// The signed-in user's live links, newest first, for the web app's list.
export async function listLinks(env: Env, userId: number) {
  const rs = await sharedDb(env)
    .prepare(
      `SELECT id, workspace_slug AS workspace, created_at AS createdAt, expires_at AS expiresAt,
              last_used_at AS lastUsedAt
         FROM chat_links
        WHERE user_id = ?1 AND revoked_at IS NULL AND expires_at > ?2
        ORDER BY id DESC`,
    )
    .bind(userId, now())
    .all<{ id: number; workspace: string; createdAt: number; expiresAt: number; lastUsedAt: number | null }>();
  return rs.results ?? [];
}

// Revokes one of the user's own links. False when it is not theirs or is
// already revoked.
export async function revokeLink(env: Env, userId: number, linkId: number): Promise<boolean> {
  const r = await sharedDb(env)
    .prepare(`UPDATE chat_links SET revoked_at = ?1 WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL`)
    .bind(now(), linkId, userId)
    .run();
  return Boolean(r.meta?.changes);
}
