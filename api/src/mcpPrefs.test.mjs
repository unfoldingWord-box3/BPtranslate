// Issue #784: the chat MCP tools bpt_get_preferences and bpt_edit_preferences.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/mcpPrefs.test.mjs
//
// The tools run the REAL translation-memory and project-config routers
// in-process, behind the REAL auth, CSRF and viewer middleware that index.ts
// mounts, against the REAL migration schema. send and sendAsAdmin are built
// here with the same adminSender index.ts uses, so these tests fail if
// PUT /prefs stops being admin-only, if the editor-capped send could reach it,
// or if adminSender stops re-checking the role or lets another route through.

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
import { adminSender, applyPrefsChanges, parsePrefsChanges } from "./mcpTools.ts";

const ADMIN = "a".repeat(40);
const EDITOR = "e".repeat(40);
const VIEWER = "v".repeat(40);

let slugCounter = 0;

function fresh({ preset = "ar-bsoj", prefs = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (8, 808, 'boss')`).run();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'reviewer')`).run();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (10, 910, 'reader')`).run();
  sqlite.prepare(`INSERT INTO project_config (id, preset, updated_at) VALUES (1, ?, unixepoch())`).run(preset);
  if (prefs) {
    sqlite
      .prepare(
        `INSERT INTO translation_prefs (id, audience, purpose, register, instructions_md, common_issues_md, version, updated_at, updated_by)
         VALUES (1, 'Arabic readers', 'Church use', 'formal', ?, ?, 5, 1, 8)`,
      )
      .run("- Keep verbs first.\n- Use الله for God.", "- Translators drop the conjunction.");
  }

  // The same middleware stack, in the same order, as index.ts.
  const app = new Hono();
  app.use("*", attachAuth);
  app.use("*", requireWorkspaceMatch);
  app.use("*", requireCsrf);
  app.use("/api/*", blockViewerWrites);
  app.route("/api/translation-memory", translationMemory);
  app.route("/api/project-config", projectConfig);

  // Records each context export the PUT queues.
  const queued = [];
  const EXPORT_WORKFLOW = {
    async create(opts) {
      queued.push(opts);
      return { id: opts.id };
    },
  };
  const env = { DB: makeDb(sqlite), JWT_SIGNING_KEY: "test-signing-key", WORKSPACE_SLUG: `p${++slugCounter}`, EXPORT_WORKFLOW };
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
      // As index.ts builds it, with the real role read from realAdmin.
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
    return { isError: reply.result.isError === true, data: JSON.parse(reply.result.content[0].text) };
  };
  const row = () => {
    const r = sqlite.prepare(`SELECT * FROM translation_prefs WHERE id = 1`).get();
    return r ? { ...r } : null;
  };
  // The preferences history (#786; prefsHistory.test.mjs covers it in full).
  const history = () => sqlite.prepare(`SELECT * FROM edit_log WHERE kind = 'prefs' ORDER BY id`).all();
  // A save from the web app (#798 tests): the real router behind the admin a
  // verified session cookie would stamp, as prefsHistory.test.mjs does, with
  // no chat principal, so edit_log records source NULL.
  const web = new Hono();
  web.use("*", async (c, next) => {
    c.set("userId", 8);
    c.set("role", "admin");
    await next();
  });
  web.use("*", attachAuth);
  web.route("/api/translation-memory", translationMemory);
  const webPut = async (body, ifMatch) =>
    asJson(
      await web.request(
        "/api/translation-memory/prefs",
        { method: "PUT", headers: { "Content-Type": "application/json", "If-Match": String(ifMatch) }, body: JSON.stringify(body) },
        env,
        ctx,
      ),
    );
  return { call, row, queued, sessions, realAdmin, history, webPut };
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

test("bpt_get_preferences: an editor reads every field, and can_edit says who may change them", async () => {
  const { call } = fresh();
  const ed = await call("bpt_get_preferences", {}, EDITOR);
  assert.equal(ed.isError, false, JSON.stringify(ed.data));
  assert.equal(ed.data.version, 5);
  assert.equal(ed.data.can_edit, false);
  assert.deepEqual(ed.data.preferences, {
    audience: "Arabic readers",
    purpose: "Church use",
    script_notes: null,
    instructions_md: "- Keep verbs first.\n- Use الله for God.",
    common_issues_md: "- Translators drop the conjunction.",
    register: "formal",
  });
  assert.ok(!("notes" in ed.data.preferences), "an editor does not see the admins' notes");
  const edNotes = await call("bpt_get_preferences", { field: "notes" }, EDITOR);
  assert.equal(edNotes.isError, true);
  assert.equal((await call("bpt_get_preferences", {})).data.preferences.notes, null, "an admin does");
  const ad = await call("bpt_get_preferences", { field: "register" });
  assert.equal(ad.data.can_edit, true);
  assert.deepEqual(ad.data.preferences, { register: "formal" });
});

test("bpt_get_preferences: never saved is version 0 with empty fields", async () => {
  const { call } = fresh({ prefs: false });
  const r = await call("bpt_get_preferences", {});
  assert.equal(r.data.version, 0);
  assert.equal(r.data.preferences.instructions_md, null);
  assert.equal(r.data.preferences.register, "default");
});

test("bpt_edit_preferences: an admin's append, replace and set land as one save by the linked user, and queue a context export", async () => {
  const { call, row, queued, history } = fresh();
  const r = await call("bpt_edit_preferences", {
    version: 5,
    set: { register: "informal", audience: "Young readers" },
    append: { common_issues_md: "- Names are spelled two ways." },
    replace: [{ field: "instructions_md", old_text: "Keep verbs first.", new_text: "Put the verb first." }],
  });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.status, "applied");
  assert.equal(r.data.version, 6);
  assert.deepEqual(r.data.changed, {
    register: "informal",
    audience: "Young readers",
    common_issues_md: "- Translators drop the conjunction.\n\n- Names are spelled two ways.",
    instructions_md: "- Put the verb first.\n- Use الله for God.",
  });
  const saved = row();
  assert.equal(saved.version, 6);
  assert.equal(saved.updated_by, 8, "saved as the linked admin");
  assert.equal(saved.purpose, "Church use", "fields not named are left alone");
  assert.equal(saved.instructions_md, "- Put the verb first.\n- Use الله for God.");
  const h = history();
  assert.equal(h.length, 1, "the save is in the preferences history");
  assert.equal(h[0].source, "chat");
  assert.equal(h[0].user_id, 8);
  assert.deepEqual(Object.keys(JSON.parse(h[0].payload_json).changed).sort(), [
    "audience",
    "common_issues_md",
    "instructions_md",
    "register",
  ]);
  await settle();
  assert.equal(queued.length, 1, "the save queues a context export, as a web save does");
});

test("bpt_edit_preferences: the first save of a never-saved project goes against version 0", async () => {
  const { call, row } = fresh({ prefs: false });
  const r = await call("bpt_edit_preferences", { version: 0, append: { instructions_md: "Use short sentences." } });
  assert.equal(r.data.status, "applied", JSON.stringify(r.data));
  assert.equal(r.data.version, 1);
  assert.equal(row().instructions_md, "Use short sentences.");
});

test("bpt_edit_preferences: an editor is refused, and nothing changes", async () => {
  const { call, row } = fresh();
  const before = row();
  const r = await call("bpt_edit_preferences", { version: 5, set: { audience: "x" } }, EDITOR);
  assert.equal(r.isError, true);
  assert.match(r.data.error, /admins only/);
  assert.deepEqual(row(), before);
});

test("an admin's ordinary send stays capped at editor: PUT /prefs refuses it", async () => {
  const { sessions, row } = fresh();
  const before = row();
  const r = await sessions[ADMIN].send("PUT", "/api/translation-memory/prefs", { audience: "x" }, 5);
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, "not_an_admin");
  assert.deepEqual(row(), before);
});

test("an admin removed since the check gets the route's 403 from sendAsAdmin, and nothing changes", async () => {
  const { sessions, realAdmin, row } = fresh();
  const before = row();
  realAdmin.set(1, false);
  const r = await sessions[ADMIN].sendAsAdmin("PUT", "/api/translation-memory/prefs", { audience: "x" }, 5);
  assert.equal(r.status, 403);
  assert.deepEqual(row(), before);
});

test("bpt_edit_preferences: a stale version is a conflict, and nothing changes", async () => {
  const { call, row } = fresh();
  const before = row();
  const r = await call("bpt_edit_preferences", { version: 4, set: { audience: "x" } });
  assert.equal(r.isError, false);
  assert.equal(r.data.status, "conflict");
  assert.equal(r.data.current_version, 5);
  assert.deepEqual(row(), before);
});

test("bpt_edit_preferences: an old_text that is missing or matches twice is refused, and nothing changes", async () => {
  const { call, row } = fresh();
  const before = row();
  const missing = await call("bpt_edit_preferences", {
    version: 5,
    replace: [{ field: "instructions_md", old_text: "not there", new_text: "y" }],
  });
  assert.equal(missing.isError, true);
  assert.match(missing.data.error, /does not contain/);
  const twice = await call("bpt_edit_preferences", {
    version: 5,
    replace: [{ field: "instructions_md", old_text: "- ", new_text: "* " }],
  });
  assert.equal(twice.isError, true);
  assert.match(twice.data.error, /more than once/);
  assert.deepEqual(row(), before);
});

test("bpt_edit_preferences: the route's length limit comes back as a refusal, and nothing changes", async () => {
  const { call, row } = fresh();
  const before = row();
  const r = await call("bpt_edit_preferences", { version: 5, set: { audience: "x".repeat(4001) } });
  assert.equal(r.isError, true);
  assert.match(r.data.error, /audience/);
  assert.deepEqual(row(), before);
});

test("viewers and authoring projects are refused for reads and edits", async () => {
  const { call } = fresh();
  const v = await call("bpt_get_preferences", {}, VIEWER);
  assert.equal(v.isError, true);
  const authoring = fresh({ preset: "en-unfoldingword" });
  for (const r of [
    await authoring.call("bpt_get_preferences", {}),
    await authoring.call("bpt_edit_preferences", { version: 5, set: { audience: "x" } }),
  ]) {
    assert.equal(r.isError, true);
    assert.match(r.data.error, /translation projects only/);
  }
});

test("bpt_get_preferences: a set too long for one result leaves out the longest fields and names them", async () => {
  const { call, sessions } = fresh();
  const longIssues = "ب".repeat(12_000);
  const longInstr = "ت".repeat(9_000);
  const put = await sessions[ADMIN].sendAsAdmin(
    "PUT",
    "/api/translation-memory/prefs",
    { common_issues_md: longIssues, instructions_md: longInstr },
    5,
  );
  assert.equal(put.status, 200);
  const all = await call("bpt_get_preferences", {});
  assert.deepEqual(all.data.left_out, ["common_issues_md"]);
  assert.equal(all.data.preferences.instructions_md, longInstr);
  assert.ok(!("common_issues_md" in all.data.preferences));
  const one = await call("bpt_get_preferences", { field: "common_issues_md" });
  assert.equal(one.data.preferences.common_issues_md, longIssues);
  assert.equal(one.data.truncated, undefined);
});

test("parsePrefsChanges refuses a field given two kinds of change, an unknown field and an empty change", () => {
  assert.throws(() => parsePrefsChanges({ set: { notes: "a" }, append: { notes: "b" } }), /both set and append/);
  assert.throws(() => parsePrefsChanges({ set: { glossary: "a" } }), /must be one of/);
  assert.throws(() => parsePrefsChanges({ append: { register: "formal" } }), /must be one of/);
  assert.throws(() => parsePrefsChanges({ set: { register: "casual" } }), /register must be one of/);
  assert.throws(() => parsePrefsChanges({}), /at least one change/);
});

test("applyPrefsChanges: append to an empty field, clear with set, and a replace that empties a field", () => {
  const cur = { version: 1, audience: "A", purpose: null, register: "default", script_notes: null, instructions_md: "only", common_issues_md: null, notes: null };
  assert.deepEqual(applyPrefsChanges(cur, parsePrefsChanges({ append: { purpose: "P" } })), { purpose: "P" });
  assert.deepEqual(applyPrefsChanges(cur, parsePrefsChanges({ set: { audience: "  " } })), { audience: null });
  assert.deepEqual(
    applyPrefsChanges(cur, parsePrefsChanges({ replace: [{ field: "instructions_md", old_text: "only", new_text: "" }] })),
    { instructions_md: null },
  );
});

test("bpt_get_preferences: one field longer than a result is cut, and says how much was shown", async () => {
  const { call, sessions } = fresh();
  const huge = "ب".repeat(50_000);
  const put = await sessions[ADMIN].sendAsAdmin("PUT", "/api/translation-memory/prefs", { common_issues_md: huge }, 5);
  assert.equal(put.status, 200);
  const one = await call("bpt_get_preferences", { field: "common_issues_md" });
  assert.equal(one.isError, false, JSON.stringify(one.data));
  assert.equal(one.data.truncated.field, "common_issues_md");
  assert.equal(one.data.truncated.total_chars, 50_000);
  assert.equal(one.data.preferences.common_issues_md.length, one.data.truncated.chars_shown);
  assert.ok(one.data.truncated.chars_shown > 5_000 && one.data.truncated.chars_shown < 15_000);
  // Still under BT Servant's 32 KB cap as it travels.
  assert.ok(Buffer.byteLength(JSON.stringify(JSON.stringify(one.data))) < 32_000);
});

test("applyPrefsChanges: a later replace sees what an earlier one left, even an emptied field", () => {
  const cur = { version: 1, audience: null, purpose: null, register: "default", script_notes: null, instructions_md: "foo", common_issues_md: null, notes: null };
  const ch = parsePrefsChanges({
    replace: [
      { field: "instructions_md", old_text: "foo", new_text: "" },
      { field: "instructions_md", old_text: "foo", new_text: "bar" },
    ],
  });
  assert.throws(() => applyPrefsChanges(cur, ch), /does not contain/);
});

test("bpt_get_preferences: a small field is kept when a large one is left out", async () => {
  const { call, sessions } = fresh();
  const big = "ت".repeat(16_000);
  const put = await sessions[ADMIN].sendAsAdmin("PUT", "/api/translation-memory/prefs", { instructions_md: big, common_issues_md: "short" }, 5);
  assert.equal(put.status, 200);
  const all = await call("bpt_get_preferences", {});
  assert.deepEqual(all.data.left_out, ["instructions_md"]);
  assert.equal(all.data.preferences.common_issues_md, "short");
});

test("sendAsAdmin refuses any route but PUT /prefs and GET /prefs/history", async () => {
  const { sessions } = fresh();
  const send = sessions[ADMIN].sendAsAdmin;
  await assert.rejects(send("PUT", "/api/project-config", {}), /does not allow/);
  // Matched exactly on the path, not as a prefix, and per method.
  await assert.rejects(send("GET", "/api/translation-memory/prefs"), /does not allow/);
  await assert.rejects(send("GET", "/api/translation-memory/prefs?limit=1"), /does not allow/);
  await assert.rejects(send("PUT", "/api/translation-memory/prefs/history", {}), /does not allow/);
  await assert.rejects(send("GET", "/api/translation-memory/prefs/history/x"), /does not allow/);
  assert.equal((await send("GET", "/api/translation-memory/prefs/history?limit=1")).status, 200);
});

// ── bpt_get_preferences_history (issue #798) ────────────────────────────────

test("bpt_get_preferences_history: a web save and a chat save, newest first, with source and changed fields", async () => {
  const { call, webPut } = fresh();
  assert.equal((await webPut({ audience: "Arabic-speaking church leaders" }, 5)).status, 200);
  const edit = await call("bpt_edit_preferences", { version: 6, set: { register: "informal" } });
  assert.equal(edit.data.status, "applied");
  const r = await call("bpt_get_preferences_history", {});
  assert.equal(r.isError, false);
  assert.equal(r.data.entries.length, 2);
  assert.equal(r.data.next, null);
  assert.equal(r.data.cut_note, undefined, "nothing was cut");
  const [chat, web] = r.data.entries;
  assert.equal(chat.version, 7);
  assert.equal(chat.source, "chat");
  assert.equal(chat.username, "boss");
  assert.deepEqual(chat.changed, { register: { prev: "formal", new: "informal" } });
  assert.equal(web.version, 6);
  assert.equal(web.source, "web");
  assert.equal(web.username, "boss");
  assert.deepEqual(web.changed, { audience: { prev: "Arabic readers", new: "Arabic-speaking church leaders" } });
  assert.match(web.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test("bpt_get_preferences_history: a non-admin gets the admins-only answer", async () => {
  const { call, webPut } = fresh();
  await webPut({ audience: "x" }, 5);
  const ed = await call("bpt_get_preferences_history", {}, EDITOR);
  assert.equal(ed.isError, true);
  assert.match(ed.data.error, /admins only/);
  // A viewer is refused earlier, as by every preferences tool.
  assert.equal((await call("bpt_get_preferences_history", {}, VIEWER)).isError, true);
});

test("bpt_get_preferences_history: an admin removed since the check gets the route's refusal", async () => {
  const { call, realAdmin, webPut } = fresh();
  await webPut({ audience: "x" }, 5);
  // isAdmin says yes, then sendAsAdmin re-reads the role and says no.
  let reads = 0;
  const orig = realAdmin.get.bind(realAdmin);
  realAdmin.get = (k) => (k === 1 ? ++reads === 1 : orig(k));
  const r = await call("bpt_get_preferences_history", {});
  assert.equal(r.isError, true);
  assert.match(r.data.error, /no longer a project admin/);
});

test("bpt_get_preferences_history: long values come back cut, with their full length", async () => {
  const { call, webPut } = fresh();
  const huge = "Watch the conjunctions. ".repeat(2000); // 48,000 characters
  assert.equal((await webPut({ common_issues_md: huge }, 5)).status, 200);
  const r = await call("bpt_get_preferences_history", {});
  assert.equal(r.isError, false);
  const ch = r.data.entries[0].changed.common_issues_md;
  assert.equal(ch.prev, "- Translators drop the conjunction.");
  assert.equal(ch.prev_total_chars, undefined);
  assert.equal(ch.new, huge.slice(0, 300));
  assert.equal(ch.new_total_chars, huge.length);
  assert.match(r.data.cut_note, /Style page, History/);
  // A cut never splits a character outside the BMP in two.
  const emoji = `${"a".repeat(299)}😀${"b".repeat(50)}`;
  assert.equal((await webPut({ audience: emoji }, 6)).status, 200);
  const e = (await call("bpt_get_preferences_history", { limit: 1 })).data.entries[0].changed.audience;
  assert.equal(e.new, "a".repeat(299));
  assert.equal(e.new_total_chars, emoji.length);
});

test("bpt_get_preferences_history: limit and before page through the entries", async () => {
  const { call, webPut } = fresh();
  for (let v = 5; v < 8; v++) assert.equal((await webPut({ purpose: `purpose ${v}` }, v)).status, 200);
  const p1 = await call("bpt_get_preferences_history", { limit: 2 });
  assert.deepEqual(p1.data.entries.map((e) => e.version), [8, 7]);
  assert.notEqual(p1.data.next, null);
  const p2 = await call("bpt_get_preferences_history", { limit: 2, before: p1.data.next });
  assert.deepEqual(p2.data.entries.map((e) => e.version), [6]);
  assert.equal(p2.data.next, null);
  // The default page is 10 and the cap 50.
  assert.equal((await call("bpt_get_preferences_history", {})).data.entries.length, 3);
  assert.equal((await call("bpt_get_preferences_history", { limit: 500 })).data.entries.length, 3);
  const bad = await call("bpt_get_preferences_history", { before: 0 });
  assert.equal(bad.isError, true);
});

test("bpt_get_preferences_history: a page too big for one response stops early, and next picks up after the last entry shown", async () => {
  const { call, webPut } = fresh();
  // Every save rewrites all six text fields with long text, so even cut to
  // 300 characters each, ten entries pass the response budget.
  const fields = ["audience", "purpose", "script_notes", "instructions_md", "common_issues_md", "notes"];
  for (let v = 5; v < 15; v++) {
    const body = Object.fromEntries(fields.map((f) => [f, `${f} ${v} `.repeat(200)]));
    assert.equal((await webPut(body, v)).status, 200);
  }
  const p1 = await call("bpt_get_preferences_history", { limit: 10 });
  assert.equal(p1.isError, false);
  const shown = p1.data.entries.map((e) => e.version);
  assert.ok(shown.length > 0 && shown.length < 10, `stopped early (${shown.length})`);
  assert.notEqual(p1.data.next, null);
  const p2 = await call("bpt_get_preferences_history", { limit: 10, before: p1.data.next });
  assert.equal(p2.data.entries[0].version, shown[shown.length - 1] - 1, "no entry skipped");
});
