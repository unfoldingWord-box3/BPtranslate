// Unit tests for chat assistant links (chatLinks.ts, issue #669) against a
// real SQLite with migration 0075 applied: codes are single use, expire, and
// are bound to one workspace; tokens resolve only in their workspace, stop on
// revoke or expiry, and never carry more than editor rights.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/chatLinks.test.mjs

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  claimCode,
  issueCode,
  listLinks,
  normalizeCode,
  resolveToken,
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
    CREATE TABLE user_roles (dcs_username TEXT PRIMARY KEY, role TEXT NOT NULL);
    INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 101, 'ada'), (2, 102, 'bo'), (3, 103, 'cy');
    INSERT INTO user_roles VALUES ('ada', 'editor'), ('bo', 'admin'), ('cy', 'viewer');
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
  assert(expiresAt - Math.floor(Date.now() / 1000) === 600, "code lives 10 minutes");
  const stored = raw.prepare("SELECT code_hash FROM chat_link_codes").all();
  assert(stored.length === 1 && !stored[0].code_hash.includes(normalizeCode(code)), "only a hash is stored");

  const wrongWs = await claimCode(env, code, "mltest");
  assert(!wrongWs.ok, "a code is refused on another workspace");
  const claim = await claimCode(env, code.toLowerCase(), "bsoj");
  assert(claim.ok && claim.principal.username === "ada" && claim.principal.role === "editor", "claim returns the user and role");
  assert(claim.token.startsWith("bpt_") && claim.token.length > 40, "token is long and prefixed");
  const again = await claimCode(env, code, "bsoj");
  assert(!again.ok, "a code works once");
  const tokenRow = raw.prepare("SELECT token_hash FROM chat_links").get();
  assert(!tokenRow.token_hash.includes(claim.token), "only a hash of the token is stored");

  const first = await issueCode(env, 1, "bsoj");
  const second = await issueCode(env, 1, "bsoj");
  assert(!(await claimCode(env, first.code, "bsoj")).ok, "a newer code cancels the older unclaimed one");
  assert((await claimCode(env, second.code, "bsoj")).ok, "the newest code works");

  const old = await issueCode(env, 1, "bsoj");
  raw.prepare("UPDATE chat_link_codes SET expires_at = 1 WHERE claimed_at IS NULL").run();
  assert(!(await claimCode(env, old.code, "bsoj")).ok, "an expired code is refused");
  assert(!(await claimCode(env, "short", "bsoj")).ok, "a malformed code is refused");
}

console.log("[tokens]");
{
  const { code } = await issueCode(env, 1, "bsoj");
  const { token, principal } = await claimCode(env, code, "bsoj");
  const p = await resolveToken(env, token, "bsoj");
  assert(p && p.userId === 1 && p.username === "ada" && p.linkId === principal.linkId, "token resolves to its user");
  assert((await resolveToken(env, token, "mltest")) === null, "token refused on another workspace");
  assert((await resolveToken(env, token + "x", "bsoj")) === null, "a wrong token resolves to no one");
  assert((await resolveToken(env, "nope", "bsoj")) === null, "a non-token string resolves to no one");

  raw.prepare("UPDATE user_roles SET role = 'viewer' WHERE dcs_username = 'ada'").run();
  assert((await resolveToken(env, token, "bsoj")).role === "viewer", "role is re-read on every call");
  raw.prepare("DELETE FROM user_roles WHERE dcs_username = 'ada'").run();
  assert((await resolveToken(env, token, "bsoj")).role === null, "removed from the team -> no role");
  raw.prepare("INSERT INTO user_roles VALUES ('ada', 'editor')").run();

  const links = await listLinks(env, 1);
  assert(links.some((l) => l.id === principal.linkId && l.workspace === "bsoj"), "the user sees the link");
  assert((await listLinks(env, 2)).length === 0, "another user does not");
  assert(!(await revokeLink(env, 2, principal.linkId)), "another user cannot revoke it");
  assert(await revokeLink(env, 1, principal.linkId), "the owner revokes it");
  assert((await resolveToken(env, token, "bsoj")) === null, "a revoked token resolves to no one");
  assert(!(await revokeLink(env, 1, principal.linkId)), "revoking twice reports not found");

  const c2 = await issueCode(env, 1, "bsoj");
  const t2 = await claimCode(env, c2.code, "bsoj");
  raw.prepare("UPDATE chat_links SET expires_at = 1 WHERE id = ?").run(t2.principal.linkId);
  assert((await resolveToken(env, t2.token, "bsoj")) === null, "an expired token resolves to no one");
  assert(!(await listLinks(env, 1)).some((l) => l.id === t2.principal.linkId), "expired links drop off the list");
}

console.log("[roles]");
{
  const { code } = await issueCode(env, 2, "bsoj");
  const claim = await claimCode(env, code, "bsoj");
  assert(claim.principal.role === "editor", "an admin is capped at editor over chat");
  const { code: c3 } = await issueCode(env, 3, "bsoj");
  const viewer = await claimCode(env, c3, "bsoj");
  assert(viewer.ok && viewer.principal.role === "viewer", "a viewer can link but stays a viewer");
}

console.log("all chatLinks tests passed");
