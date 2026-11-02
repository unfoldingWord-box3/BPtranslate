// Unit tests for chat assistant links (chatLinks.ts, issue #669) against a
// real SQLite with migration 0075 applied: codes are single use, expire, and
// carry the workspace they were issued in to the link; tokens stop on revoke
// or expiry; the role is read from the link's workspace and never carries
// more than editor rights.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/chatLinks.test.mjs

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  chatRoleFor,
  claimCode,
  issueCode,
  listLinks,
  lookupLink,
  normalizeCode,
  revokeLink,
} from "./chatLinks.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dcs_user_id INTEGER NOT NULL UNIQUE,
      dcs_username TEXT NOT NULL
    );
    CREATE TABLE user_roles (dcs_username TEXT PRIMARY KEY, role TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', synced_at INTEGER);
    INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 101, 'ada'), (2, 102, 'bo'), (3, 103, 'cy');
    INSERT INTO user_roles (dcs_username, role) VALUES ('ada', 'editor'), ('bo', 'admin'), ('cy', 'viewer');
  `);
  db.exec(readFileSync(new URL("../migrations/0075_chat_links.sql", import.meta.url), "utf8"));
  return db;
}

function sqliteD1(db) {
  function bound(sql, args) {
    return {
      first: async () => db.prepare(sql).get(...args) ?? null,
      run: async () => {
        const r = db.prepare(sql).run(...args);
        return { meta: { changes: Number(r.changes) } };
      },
      all: async () => ({ results: db.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare(sql) {
      return { bind: (...args) => bound(sql, args), ...bound(sql, []) };
    },
  };
}

const raw = freshDb();
const env = { DB: sqliteD1(raw) };

console.log("[codes]");
assert(normalizeCode(" abcd-efgh ") === "ABCDEFGH", "codes are normalized: case, dash, spaces");
{
  const { code, expiresAt } = await issueCode(env, 1, "bsoj");
  assert(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code), `code shape ABCD-EFGH without 0/O/1/I (${code})`);
  const ttl = expiresAt - Math.floor(Date.now() / 1000);
  assert(ttl >= 599 && ttl <= 600, "code lives 10 minutes");
  const stored = raw.prepare("SELECT code_hash FROM chat_link_codes").all();
  assert(stored.length === 1 && !stored[0].code_hash.includes(normalizeCode(code)), "only a hash is stored");

  const claim = await claimCode(env, code.toLowerCase());
  assert(claim.ok && claim.link.username === "ada" && claim.link.userId === 1, "claim returns the user");
  assert(claim.link.workspaceSlug === "bsoj", "claim takes the workspace from the code");
  assert(claim.link.role === undefined, "claim reads no role (that needs the workspace's database)");
  assert(claim.token.startsWith("bpt_") && claim.token.length > 40, "token is long and prefixed");
  const again = await claimCode(env, code);
  assert(!again.ok, "a code works once");
  const tokenRow = raw.prepare("SELECT token_hash, workspace_slug FROM chat_links").get();
  assert(!tokenRow.token_hash.includes(claim.token), "only a hash of the token is stored");
  assert(tokenRow.workspace_slug === "bsoj", "the link row records the code's workspace");

  const ml = await issueCode(env, 1, "mltest");
  const mlClaim = await claimCode(env, ml.code);
  assert(mlClaim.ok && mlClaim.link.workspaceSlug === "mltest", "a code issued in mltest links mltest");

  const first = await issueCode(env, 1, "bsoj");
  const second = await issueCode(env, 1, "bsoj");
  assert(!(await claimCode(env, first.code)).ok, "a newer code cancels the older unclaimed one");
  assert((await claimCode(env, second.code)).ok, "the newest code works");

  const inA = await issueCode(env, 1, "bsoj");
  await issueCode(env, 1, "mltest");
  assert((await claimCode(env, inA.code)).ok, "a code in another workspace does not cancel this one");

  raw.prepare("INSERT INTO chat_link_codes (code_hash, user_id, workspace_slug, expires_at) VALUES ('stale', 2, 'bsoj', 1)").run();
  await issueCode(env, 1, "bsoj");
  assert(!raw.prepare("SELECT 1 FROM chat_link_codes WHERE code_hash = 'stale'").get(), "codes older than a day are purged");

  const old = await issueCode(env, 1, "bsoj");
  raw.prepare("UPDATE chat_link_codes SET expires_at = 1 WHERE claimed_at IS NULL").run();
  assert(!(await claimCode(env, old.code)).ok, "an expired code is refused");
  assert(!(await claimCode(env, "short")).ok, "a malformed code is refused");
}

console.log("[tokens]");
{
  const { code } = await issueCode(env, 1, "bsoj");
  const { token, link } = await claimCode(env, code);
  const l = await lookupLink(env, token);
  assert(l && l.userId === 1 && l.username === "ada" && l.linkId === link.linkId, "token resolves to its user");
  assert(l.workspaceSlug === "bsoj", "token resolves to its workspace");
  assert((await lookupLink(env, token + "x")) === null, "a wrong token resolves to no one");
  assert((await lookupLink(env, "nope")) === null, "a non-token string resolves to no one");

  const links = await listLinks(env, 1);
  assert(links.some((x) => x.id === link.linkId && x.workspace === "bsoj"), "the user sees the link");
  assert((await listLinks(env, 2)).length === 0, "another user does not");
  assert(!(await revokeLink(env, 2, link.linkId)), "another user cannot revoke it");
  assert(await revokeLink(env, 1, link.linkId), "the owner revokes it");
  assert((await lookupLink(env, token)) === null, "a revoked token resolves to no one");
  assert(!(await revokeLink(env, 1, link.linkId)), "revoking twice reports not found");

  const c2 = await issueCode(env, 1, "bsoj");
  const t2 = await claimCode(env, c2.code);
  raw.prepare("UPDATE chat_links SET expires_at = 1 WHERE id = ?").run(t2.link.linkId);
  assert((await lookupLink(env, t2.token)) === null, "an expired token resolves to no one");
  assert(!(await listLinks(env, 1)).some((x) => x.id === t2.link.linkId), "expired links drop off the list");
}

console.log("[roles]");
{
  // A second workspace database where ada is only a viewer and bo has no role.
  const other = new DatabaseSync(":memory:");
  other.exec(`
    CREATE TABLE user_roles (dcs_username TEXT PRIMARY KEY, role TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', synced_at INTEGER);
    INSERT INTO user_roles (dcs_username, role) VALUES ('ada', 'viewer');
  `);
  const otherEnv = { DB: sqliteD1(other), SHARED_DB: env.DB };
  assert((await chatRoleFor(env, "ada")) === "editor", "role read from the workspace's own database");
  assert((await chatRoleFor(otherEnv, "ada")) === "viewer", "the same user has another workspace's role there");
  assert((await chatRoleFor(otherEnv, "bo")) === null, "no role row there -> null");
  assert((await chatRoleFor(env, "bo")) === "editor", "an admin is capped at editor over chat");
  assert((await chatRoleFor(env, "cy")) === "viewer", "a viewer stays a viewer");

  raw.prepare("UPDATE user_roles SET role = 'viewer' WHERE dcs_username = 'ada'").run();
  assert((await chatRoleFor(env, "ada")) === "viewer", "role is re-read on every call");
  raw.prepare("DELETE FROM user_roles WHERE dcs_username = 'ada'").run();
  assert((await chatRoleFor(env, "ada")) === null, "removed from the team -> no role");
}

console.log("all chatLinks tests passed");
