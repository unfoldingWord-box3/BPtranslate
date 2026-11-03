// Issue #785: the chat MCP terminology tools bpt_list_terms, bpt_add_term,
// bpt_edit_term and bpt_delete_term.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/mcpTerms.test.mjs
//
// The tools run the REAL translation-memory and project-config routers
// in-process, behind the REAL auth, CSRF and viewer middleware that index.ts
// mounts, against the REAL migration schema (so the duplicate case meets the
// real unique index). The term routes accept editors; the admin-only rule for
// writes lives in the tools (session.isAdmin), so these tests fail if a write
// tool forgets to ask.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { translationMemory } from "./translationMemory.ts";
import { projectConfig } from "./projectConfigRoutes.ts";
import { attachAuth, chatWriteEnv, requireCsrf } from "./auth.ts";
import { requireWorkspaceMatch } from "./workspaces.ts";
import { blockViewerWrites } from "./viewerGuard.ts";
import { dispatch } from "./mcp.ts";
import { adminSender } from "./mcpTools.ts";

const ADMIN = "a".repeat(40);
const EDITOR = "e".repeat(40);
const VIEWER = "v".repeat(40);

let slugCounter = 0;

function fresh({ preset = "ar-bsoj", terms = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (8, 808, 'boss')`).run();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'reviewer')`).run();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (10, 910, 'reader')`).run();
  sqlite.prepare(`INSERT INTO project_config (id, preset, updated_at) VALUES (1, ?, unixepoch())`).run(preset);
  if (terms) {
    const ins = sqlite.prepare(
      `INSERT INTO terminology (id, concept_id, source_term, target_term, status, replacement, comment, version, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 8)`,
    );
    ins.run(1, "grace", "grace", "نعمة", "preferred", null, "Use in every book.", 3);
    ins.run(2, "grace", "grace", "فضل", "forbidden", "نعمة", null, 1);
    ins.run(3, "god", "God", "الله", "preferred", null, null, 2);
  }

  // The same middleware stack, in the same order, as index.ts.
  const app = new Hono();
  app.use("*", attachAuth);
  app.use("*", requireWorkspaceMatch);
  app.use("*", requireCsrf);
  app.use("/api/*", blockViewerWrites);
  app.route("/api/translation-memory", translationMemory);
  app.route("/api/project-config", projectConfig);

  // Records each context export a term save queues.
  const queued = [];
  const EXPORT_WORKFLOW = {
    async create(opts) {
      queued.push(opts);
      return { id: opts.id };
    },
  };
  const env = { DB: makeDb(sqlite), JWT_SIGNING_KEY: "test-signing-key", WORKSPACE_SLUG: `t${++slugCounter}`, EXPORT_WORKFLOW };
  const ctx = {
    waitUntil(p) {
      if (p && typeof p.catch === "function") p.catch(() => {});
    },
    passThroughOnException() {},
  };
  const asJson = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
  const sendAs = async (principal, method, path, body, ifMatch) => {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (ifMatch !== undefined) headers["If-Match"] = String(ifMatch);
    return asJson(
      await app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, chatWriteEnv(env, principal), ctx),
    );
  };
  // admin: the user's real role (index.ts reads it with chatIsAdmin on every
  // call); the principal is capped at editor, as chatRoleFor caps it.
  const realAdmin = new Map();
  const sessionFor = (principal, admin) => {
    realAdmin.set(principal.linkId, admin);
    return {
      workspace: { slug: "default", label: "Default", org: "Org" },
      principal,
      getJson: async (path) => asJson(await app.request(path, {}, env, ctx)),
      send: (method, path, body, ifMatch) => sendAs(principal, method, path, body, ifMatch),
      sendAsAdmin: adminSender(
        async () => realAdmin.get(principal.linkId),
        (method, path, body, ifMatch) => sendAs({ ...principal, role: "admin" }, method, path, body, ifMatch),
      ),
      isAdmin: async () => realAdmin.get(principal.linkId),
    };
  };
  const sessions = {
    [ADMIN]: sessionFor({ userId: 8, username: "boss", role: "editor", linkId: 1 }, true),
    [EDITOR]: sessionFor({ userId: 9, username: "reviewer", role: "editor", linkId: 2 }, false),
    [VIEWER]: sessionFor({ userId: 10, username: "reader", role: null, linkId: 3 }, false),
  };
  const toolCtx = { session: async (t) => sessions[t] ?? null, claimLink: async () => ({ ok: false }) };
  const call = async (name, args, token = ADMIN) => {
    const reply = await dispatch(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { session_token: token, ...args } } },
      toolCtx,
    );
    const text = reply.result.content[0].text;
    return { isError: reply.result.isError === true, data: JSON.parse(text), wireBytes: Buffer.byteLength(JSON.stringify(reply)) };
  };
  const table = () => sqlite.prepare(`SELECT * FROM terminology ORDER BY id`).all().map((r) => ({ ...r }));
  const term = (id) => {
    const r = sqlite.prepare(`SELECT * FROM terminology WHERE id = ?`).get(id);
    return r ? { ...r } : null;
  };
  // send: a direct call to the term routes as the admin's chat principal.
  return { call, table, term, queued, sqlite, realAdmin, send: sessions[ADMIN].send };
}

function makeDb(sqlite) {
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    all() {
      return { results: sqlite.prepare(sql).all(...args), success: true };
    },
    first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    run() {
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      return stmts.map((s) => s.run());
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test("bpt_list_terms: an editor reads every term in the route's order, and can_edit says who may change them", async () => {
  const { call } = fresh();
  const ed = await call("bpt_list_terms", {}, EDITOR);
  assert.equal(ed.isError, false, JSON.stringify(ed.data));
  assert.equal(ed.data.can_edit, false);
  assert.equal(ed.data.total, 3);
  assert.equal(ed.data.next_cursor, null);
  assert.deepEqual(ed.data.terms.map((t) => t.id), [3, 2, 1], "concept_id, then status");
  assert.deepEqual(ed.data.terms[1], {
    id: 2,
    version: 1,
    concept_id: "grace",
    source_term: "grace",
    target_term: "فضل",
    status: "forbidden",
    replacement: "نعمة",
    comment: null,
    tw_link: null,
    source_status: "manual",
  });
  assert.equal((await call("bpt_list_terms", {})).data.can_edit, true, "an admin may");
});

test("bpt_list_terms: q and status filter as the route does, and an unknown status is refused", async () => {
  const { call } = fresh();
  const q = await call("bpt_list_terms", { q: "الله" }, EDITOR);
  assert.deepEqual(q.data.terms.map((t) => t.id), [3]);
  const s = await call("bpt_list_terms", { status: "forbidden" }, EDITOR);
  assert.deepEqual(s.data.terms.map((t) => t.id), [2]);
  const bad = await call("bpt_list_terms", { status: "forbiden" }, EDITOR);
  assert.equal(bad.isError, true, "the route would silently return every term");
  assert.match(bad.data.error, /status must be one of/);
});

test("bpt_add_term: an admin's term lands trimmed, as the linked user, and queues a context export", async () => {
  const { call, term, queued } = fresh();
  const r = await call("bpt_add_term", {
    concept_id: " faith ",
    source_term: "faith",
    target_term: " إيمان ",
    comment: "",
  });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.status, "added");
  assert.equal(r.data.term.concept_id, "faith");
  assert.equal(r.data.term.target_term, "إيمان");
  assert.equal(r.data.term.status, "preferred", "status defaults to preferred");
  assert.equal(r.data.term.comment, null, "an empty optional field is null");
  assert.equal(r.data.term.version, 1);
  const saved = term(r.data.term.id);
  assert.equal(saved.updated_by, 8, "saved as the linked admin");
  assert.equal(saved.source_status, "manual");
  await settle();
  assert.equal(queued.length, 1, "the save queues a context export, as a web save does");
});

test("bpt_edit_term: an admin's edit lands, and moving off forbidden clears replacement as the web app does", async () => {
  const { call, term } = fresh();
  const r = await call("bpt_edit_term", { id: 2, version: 1, status: "deprecated", comment: "Older Bibles use it." });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.status, "applied");
  assert.equal(r.data.term.version, 2);
  assert.equal(r.data.term.status, "deprecated");
  assert.equal(r.data.term.replacement, null);
  const saved = term(2);
  assert.equal(saved.comment, "Older Bibles use it.");
  assert.equal(saved.target_term, "فضل", "fields not named are left alone");
  assert.equal(saved.replacement, null);
  const cleared = await call("bpt_edit_term", { id: 1, version: 3, comment: null });
  assert.equal(cleared.data.status, "applied");
  assert.equal(term(1).comment, null);
});

test("bpt_delete_term: an admin's delete soft-deletes the term, and it leaves the list", async () => {
  const { call, term } = fresh();
  const r = await call("bpt_delete_term", { id: 3, version: 2 });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.deepEqual(r.data, { status: "deleted", id: 3 });
  assert.ok(term(3).deleted_at, "soft-deleted, as the web app deletes");
  const list = await call("bpt_list_terms", {});
  assert.deepEqual(list.data.terms.map((t) => t.id), [2, 1]);
  const again = await call("bpt_delete_term", { id: 3, version: 2 });
  assert.equal(again.isError, true);
  assert.match(again.data.error, /no term with id 3.*Nothing was saved/);
});

test("bpt_delete_term: a stale version is a conflict with the term as it is now, and the term stays", async () => {
  const { call, table, term } = fresh();
  const before = table();
  const r = await call("bpt_delete_term", { id: 1, version: 2 });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.status, "conflict");
  assert.equal(r.data.current.version, 3);
  assert.equal(term(1).deleted_at, null);
  assert.deepEqual(table(), before);
  const noVersion = await call("bpt_delete_term", { id: 1 });
  assert.equal(noVersion.isError, true);
  assert.deepEqual(table(), before);
});

test("an editor's add, edit and delete are refused, and nothing changes", async () => {
  const { call, table, queued } = fresh();
  const before = table();
  for (const r of [
    await call("bpt_add_term", { concept_id: "faith", source_term: "faith" }, EDITOR),
    await call("bpt_edit_term", { id: 1, version: 3, target_term: "x" }, EDITOR),
    await call("bpt_delete_term", { id: 1, version: 3 }, EDITOR),
  ]) {
    assert.equal(r.isError, true);
    assert.match(r.data.error, /project admins only, and reviewer is not one here\. Nothing was saved\./);
  }
  assert.deepEqual(table(), before);
  await settle();
  assert.equal(queued.length, 0);
});

test("bpt_edit_term: a stale version is a conflict with the term as it is now, and nothing changes", async () => {
  const { call, table } = fresh();
  const before = table();
  const r = await call("bpt_edit_term", { id: 1, version: 2, target_term: "x" });
  assert.equal(r.isError, false);
  assert.equal(r.data.status, "conflict");
  assert.equal(r.data.current.version, 3);
  assert.equal(r.data.current.target_term, "نعمة");
  assert.match(r.data.message, /nothing was saved/);
  assert.deepEqual(table(), before);
});

test("a duplicate term is refused, by add and by edit, and nothing changes", async () => {
  const { call, table } = fresh();
  const before = table();
  const add = await call("bpt_add_term", { concept_id: "GRACE", source_term: "grace", target_term: "نعمة" });
  assert.equal(add.isError, true);
  assert.match(add.data.error, /already has a term .*id 1, version 3.*bpt_edit_term.*Nothing was saved\./);
  const edit = await call("bpt_edit_term", { id: 3, version: 2, concept_id: "grace", source_term: "grace", target_term: "نعمة" });
  assert.equal(edit.isError, true);
  assert.match(edit.data.error, /already has a term .*id 1/);
  assert.deepEqual(table(), before);
});

test("forbidden needs a replacement, and replacement is only for forbidden; nothing changes", async () => {
  const { call, table } = fresh();
  const before = table();
  const noRepl = await call("bpt_add_term", { concept_id: "x", source_term: "x", status: "forbidden" });
  assert.match(noRepl.data.error, /needs a replacement/);
  const stray = await call("bpt_add_term", { concept_id: "x", source_term: "x", replacement: "y" });
  assert.match(stray.data.error, /only for forbidden/);
  const toForbidden = await call("bpt_edit_term", { id: 3, version: 2, status: "forbidden" });
  assert.equal(toForbidden.isError, true, "the route's own rule comes back as a refusal");
  assert.match(toForbidden.data.error, /forbidden term must carry a replacement.*Nothing was saved/);
  const clearRepl = await call("bpt_edit_term", { id: 2, version: 1, replacement: null });
  assert.match(clearRepl.data.error, /forbidden term must carry a replacement/);
  const empty = await call("bpt_edit_term", { id: 1, version: 3 });
  assert.match(empty.data.error, /at least one field/);
  const noSource = await call("bpt_edit_term", { id: 1, version: 3, source_term: "  " });
  assert.match(noSource.data.error, /source_term cannot be empty/);
  assert.deepEqual(table(), before);
});

test("viewers and authoring projects are refused for reads and writes", async () => {
  const { call, table } = fresh();
  const before = table();
  for (const r of [
    await call("bpt_list_terms", {}, VIEWER),
    await call("bpt_add_term", { concept_id: "x", source_term: "x" }, VIEWER),
  ]) {
    assert.equal(r.isError, true);
    assert.match(r.data.error, /cannot edit in this project/);
  }
  assert.deepEqual(table(), before);
  const authoring = fresh({ preset: "en-unfoldingword" });
  const authBefore = authoring.table();
  for (const r of [
    await authoring.call("bpt_list_terms", {}),
    await authoring.call("bpt_add_term", { concept_id: "x", source_term: "x" }),
    await authoring.call("bpt_edit_term", { id: 1, version: 3, target_term: "x" }),
    await authoring.call("bpt_delete_term", { id: 1, version: 3 }),
  ]) {
    assert.equal(r.isError, true);
    assert.match(r.data.error, /translation projects only/);
  }
  assert.deepEqual(authoring.table(), authBefore);
});

test("an admin removed since linking is refused by the write tools", async () => {
  const { call, table, realAdmin } = fresh();
  const before = table();
  realAdmin.set(1, false);
  const r = await call("bpt_delete_term", { id: 1, version: 3 });
  assert.equal(r.isError, true);
  assert.match(r.data.error, /admins only/);
  assert.deepEqual(table(), before);
});

test("bpt_list_terms: long Arabic terms page under the chat's 32 KB cap, and the cursor reaches every term once", async () => {
  const { call, sqlite } = fresh({ terms: false });
  const ins = sqlite.prepare(
    `INSERT INTO terminology (concept_id, source_term, target_term, status, comment, version) VALUES (?, ?, ?, 'preferred', ?, 1)`,
  );
  for (let i = 0; i < 30; i++) {
    const n = String(i).padStart(2, "0");
    ins.run(`c${n}`, `src${n}`, "ت".repeat(1000), `"${"ب".repeat(3990)}"`);
  }
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const r = await call("bpt_list_terms", { limit: 100, ...(cursor ? { cursor } : {}) }, EDITOR);
    assert.equal(r.isError, false, JSON.stringify(r.data));
    assert.ok(r.wireBytes < 32_000, `page ${pages} is ${r.wireBytes} bytes on the wire`);
    assert.ok(r.data.returned >= 1);
    assert.equal(r.data.total, 30);
    seen.push(...r.data.terms.map((t) => t.concept_id));
    cursor = r.data.next_cursor;
    pages++;
  } while (cursor && pages < 40);
  assert.ok(pages > 1, "the terms did not fit one page");
  assert.deepEqual(seen, Array.from({ length: 30 }, (_, i) => `c${String(i).padStart(2, "0")}`));
});

test("bpt_list_terms: the cursor follows SQLite's byte order, not JavaScript's, past characters above U+FFFF", async () => {
  const { call, sqlite } = fresh({ terms: false });
  const ins = sqlite.prepare(`INSERT INTO terminology (concept_id, source_term, status, version) VALUES (?, 'x', 'preferred', 1)`);
  // U+FB50 (an Arabic presentation form) sorts before U+1D400 in UTF-8 bytes,
  // after it in UTF-16 code units.
  for (const c of ["\u{1D400}", "ﭐ", "a"]) ins.run(c);
  const seen = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await call("bpt_list_terms", { limit: 1, ...(cursor ? { cursor } : {}) }, EDITOR);
    seen.push(...r.data.terms.map((t) => t.concept_id));
    cursor = r.data.next_cursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, ["a", "ﭐ", "\u{1D400}"]);
});

test("bpt_list_terms: a cursor it did not return is refused", async () => {
  const { call } = fresh();
  const r = await call("bpt_list_terms", { cursor: "[1,2]" }, EDITOR);
  assert.equal(r.isError, true);
  assert.match(r.data.error, /cursor is not one this tool returned/);
});

test("bpt_list_terms: quote-heavy comments still page under the 32 KB cap as they travel", async () => {
  const { call, sqlite } = fresh({ terms: false });
  const ins = sqlite.prepare(`INSERT INTO terminology (concept_id, source_term, status, comment, version) VALUES (?, 'x', 'preferred', ?, 1)`);
  for (let i = 0; i < 40; i++) ins.run(`c${String(i).padStart(2, "0")}`, '"\\'.repeat(1500));
  let cursor;
  let seen = 0;
  for (let pages = 0; pages < 60; pages++) {
    const r = await call("bpt_list_terms", { limit: 100, ...(cursor ? { cursor } : {}) }, EDITOR);
    assert.equal(r.isError, false, JSON.stringify(r.data));
    assert.ok(r.wireBytes < 32_000, `page ${pages} is ${r.wireBytes} bytes on the wire`);
    seen += r.data.returned;
    cursor = r.data.next_cursor;
    if (!cursor) break;
  }
  assert.equal(seen, 40);
});

test("bpt_list_terms: a cursor reused with another q or status is refused", async () => {
  const { call } = fresh();
  const first = await call("bpt_list_terms", { limit: 1 }, EDITOR);
  assert.ok(first.data.next_cursor);
  const other = await call("bpt_list_terms", { limit: 1, status: "preferred", cursor: first.data.next_cursor }, EDITOR);
  assert.equal(other.isError, true);
  assert.match(other.data.error, /different search/);
  const same = await call("bpt_list_terms", { limit: 1, cursor: first.data.next_cursor }, EDITOR);
  assert.equal(same.isError, false, JSON.stringify(same.data));
});

test("bpt_list_terms: past the route's 2000-row cap the result says there may be more", async () => {
  const { call, sqlite } = fresh({ terms: false });
  const ins = sqlite.prepare(`INSERT INTO terminology (concept_id, source_term, status, version) VALUES (?, 'x', 'preferred', 1)`);
  for (let i = 0; i < 2001; i++) ins.run(`c${String(i).padStart(4, "0")}`);
  const r = await call("bpt_list_terms", { limit: 1 }, EDITOR);
  assert.equal(r.data.may_be_more, true);
  assert.match(r.data.may_be_more_note, /may be more/);
  // Exactly 2000, unfiltered: the count says that is everything.
  sqlite.prepare(`UPDATE terminology SET deleted_at = unixepoch() WHERE concept_id = 'c2000'`).run();
  const exact = await call("bpt_list_terms", { limit: 1 }, EDITOR);
  assert.equal(exact.data.may_be_more, undefined);
  // Filtered, nothing can tell, so it still says there may be more.
  const filtered = await call("bpt_list_terms", { limit: 1, status: "preferred" }, EDITOR);
  assert.equal(filtered.data.may_be_more, true);
});

test("bpt_edit_term: a replacement without status forbidden is refused, and nothing changes", async () => {
  const { call, table } = fresh();
  const before = table();
  const r = await call("bpt_edit_term", { id: 1, version: 3, replacement: "x" });
  assert.equal(r.isError, true);
  assert.match(r.data.error, /also pass status forbidden/);
  assert.deepEqual(table(), before);
  const ok = await call("bpt_edit_term", { id: 2, version: 1, status: "forbidden", replacement: "نعمة الله" });
  assert.equal(ok.isError, false, JSON.stringify(ok.data));
  assert.equal(ok.data.term.replacement, "نعمة الله");
});

// Issue #791: the term routes themselves (the web client calls these too).

test("DELETE /terms/:id: a stale If-Match is a 409 with the term as it is now, and the term stays", async () => {
  const { send, table, term, queued } = fresh();
  const before = table();
  const r = await send("DELETE", "/api/translation-memory/terms/1", undefined, 2);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "version_mismatch");
  assert.equal(r.body.current.id, 1);
  assert.equal(r.body.current.version, 3);
  assert.deepEqual(table(), before);
  await settle();
  assert.equal(queued.length, 0, "a refused delete queues no export");
  const ok = await send("DELETE", "/api/translation-memory/terms/1", undefined, 3);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true });
  assert.ok(term(1).deleted_at);
  const gone = await send("DELETE", "/api/translation-memory/terms/1", undefined, 3);
  assert.equal(gone.status, 404, "already deleted is not_found, not a version conflict");
});

test("DELETE /terms/:id: without If-Match it deletes as before; an unreadable If-Match is a 400", async () => {
  const { send, table, term } = fresh();
  const before = table();
  const bad = await send("DELETE", "/api/translation-memory/terms/3", undefined, "abc");
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "bad_if_match");
  assert.deepEqual(table(), before);
  const plain = await send("DELETE", "/api/translation-memory/terms/3");
  assert.equal(plain.status, 200);
  assert.ok(term(3).deleted_at);
  const missing = await send("DELETE", "/api/translation-memory/terms/99");
  assert.equal(missing.status, 404);
});

test("GET /terms: an unknown status is a 400 and returns no terms; an empty one is no filter", async () => {
  const { send } = fresh();
  const bad = await send("GET", "/api/translation-memory/terms?status=bogus");
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "bad_status");
  assert.ok(bad.body.allowed.includes("preferred"));
  assert.equal(bad.body.terms, undefined);
  const empty = await send("GET", "/api/translation-memory/terms?status=");
  assert.equal(empty.status, 200);
  assert.equal(empty.body.terms.length, 3);
});

test("GET /terms/count: takes the same q and status filters as GET /terms, so a filtered count equals the filtered list", async () => {
  const { send } = fresh();
  const base = "/api/translation-memory/terms";
  for (const qs of ["", "?status=preferred", "?status=forbidden", "?status=deprecated", "?q=grace", "?q=GOD", "?q=grace&status=forbidden", "?q=nothing-matches", "?q=%25"]) {
    const list = await send("GET", `${base}${qs}`);
    const count = await send("GET", `${base}/count${qs}`);
    assert.equal(list.status, 200, qs);
    assert.equal(count.status, 200, qs);
    assert.equal(count.body.count, list.body.terms.length, `count matches list for "${qs}"`);
  }
  assert.equal((await send("GET", `${base}/count?status=forbidden`)).body.count, 1);
  assert.equal((await send("GET", `${base}/count?q=grace`)).body.count, 2);
  assert.equal((await send("GET", `${base}/count`)).body.count, 3);
  const bad = await send("GET", `${base}/count?status=bogus`);
  assert.equal(bad.status, 400);
});
