// Issue #786: every successful PUT /api/translation-memory/prefs writes one
// edit_log entry (kind 'prefs', row_key '1'), from the web app (source NULL)
// or from chat (source 'chat'), with the previous and new values of the fields
// that changed. A 409 or 400 writes none.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/prefsHistory.test.mjs
//
// The REAL translation-memory router runs behind the REAL attachAuth, against
// the REAL migration schema. A web request is stamped as the admin the way a
// verified session cookie would; a chat request goes through chatWriteEnv,
// which is what the chat tools' sendAsAdmin uses (mcpPrefs.test.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { translationMemory } from "./translationMemory.ts";
import { attachAuth, chatWriteEnv } from "./auth.ts";
import { rowTouchedAfterJobSql, rowTouchedAfterJobBindings } from "./pipelineDedupSql.ts";
// The web app's restore helper (issue #788), so the restore test below runs
// the real client algorithm against the real router.
import { rebuildPrefsVersion } from "../../web/src/lib/prefsHistory.ts";

const FIELDS = ["audience", "purpose", "register", "script_notes", "instructions_md", "common_issues_md", "notes"];
let slugCounter = 0;

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
    // D1 runs a batch's statements in order in one transaction; changes()
    // inside the second statement sees the first, as it does here.
    async batch(stmts) {
      sqlite.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

function fresh({ prefs = true, role = "admin" } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (8, 808, 'boss')`).run();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'other-admin')`).run();
  if (prefs) {
    sqlite
      .prepare(
        `INSERT INTO translation_prefs (id, audience, purpose, register, instructions_md, common_issues_md, version, updated_at, updated_by)
         VALUES (1, 'Arabic readers', 'Church use', 'formal', ?, ?, 5, 1, 8)`,
      )
      .run("- Keep verbs first.\n- Use الله for God.", "- Translators drop the conjunction.");
  }

  const app = new Hono();
  // A web request: the admin a verified session cookie would stamp. attachAuth
  // runs after and replaces it with the chat principal on a chat request.
  app.use("*", async (c, next) => {
    c.set("userId", 8);
    c.set("role", role);
    await next();
  });
  app.use("*", attachAuth);
  app.route("/api/translation-memory", translationMemory);

  const EXPORT_WORKFLOW = { async create(opts) { return { id: opts.id }; } };
  const env = { DB: makeDb(sqlite), JWT_SIGNING_KEY: "test-signing-key", WORKSPACE_SLUG: `h${++slugCounter}`, EXPORT_WORKFLOW };
  const ctx = {
    waitUntil(p) {
      if (p && typeof p.catch === "function") p.catch(() => {});
    },
    passThroughOnException() {},
  };
  const put = async (body, ifMatch, { chat = false, raw = false } = {}) => {
    const headers = { "Content-Type": "application/json" };
    if (ifMatch !== undefined) headers["If-Match"] = String(ifMatch);
    const reqEnv = chat ? chatWriteEnv(env, { userId: 9, username: "other-admin", role: "admin" }) : env;
    const res = await app.request(
      "/api/translation-memory/prefs",
      { method: "PUT", headers, body: raw ? body : JSON.stringify(body) },
      reqEnv,
      ctx,
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const row = () => {
    const r = sqlite.prepare(`SELECT * FROM translation_prefs WHERE id = 1`).get();
    return r ? { ...r } : null;
  };
  const history = () =>
    sqlite
      .prepare(`SELECT * FROM edit_log WHERE kind = 'prefs' ORDER BY id`)
      .all()
      .map((r) => ({ ...r, payload: JSON.parse(r.payload_json) }));
  const logCount = () => Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log`).get().n);
  // GET /prefs/history (issue #788), as the web user.
  const getHistory = async (query = "") => {
    const res = await app.request(`/api/translation-memory/prefs/history${query}`, { method: "GET" }, env, ctx);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { sqlite, put, row, history, logCount, getHistory };
}

const pick = (r) => Object.fromEntries(FIELDS.map((f) => [f, r[f]]));

// The row as it was before `entry`: the saved row with every `prev` put back.
function undo(saved, entry) {
  const out = pick(saved);
  for (const [f, v] of Object.entries(entry.payload.changed)) out[f] = v.prev;
  return out;
}

test("a web save records one entry: source NULL, the admin, prev/new version, and only the fields that changed", async () => {
  const { put, row, history } = fresh();
  const before = row();
  const r = await put({ register: "informal", instructions_md: "- Put the verb first." }, 5);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const h = history();
  assert.equal(h.length, 1);
  const [e] = h;
  assert.equal(e.row_key, "1");
  assert.equal(e.book, null);
  assert.equal(e.action, "update");
  assert.equal(e.source, null);
  assert.equal(e.user_id, 8);
  assert.equal(e.prev_version, 5);
  assert.equal(e.new_version, 6);
  assert.equal(e.new_version, row().version);
  assert.deepEqual(e.payload.changed, {
    register: { prev: "formal", new: "informal" },
    instructions_md: { prev: before.instructions_md, new: "- Put the verb first." },
  });
});

test("a chat save records one entry marked chat, as the chat user", async () => {
  const { put, history } = fresh();
  const r = await put({ audience: "Young readers" }, 5, { chat: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const h = history();
  assert.equal(h.length, 1);
  assert.equal(h[0].source, "chat");
  assert.equal(h[0].user_id, 9);
  assert.deepEqual(h[0].payload.changed, { audience: { prev: "Arabic readers", new: "Young readers" } });
});

test("the first save at version 0 records one 'create' entry against the defaults", async () => {
  const { put, row, history } = fresh({ prefs: false });
  const r = await put({ purpose: "Teaching", register: "formal" }, 0);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const h = history();
  assert.equal(h.length, 1);
  assert.equal(h[0].action, "create");
  assert.equal(h[0].prev_version, 0);
  assert.equal(h[0].new_version, 1);
  assert.equal(row().version, 1);
  assert.deepEqual(h[0].payload.changed, {
    purpose: { prev: null, new: "Teaching" },
    register: { prev: "default", new: "formal" },
  });
});

test("a 409 records nothing: stale If-Match, If-Match ahead of the row, and a first write against a saved row", async () => {
  const { put, history, logCount, row } = fresh();
  const n = logCount();
  assert.equal((await put({ audience: "x" }, 4)).status, 409);
  assert.equal((await put({ audience: "x" }, 6)).status, 409);
  assert.equal((await put({ audience: "x" }, 0)).status, 409);
  assert.equal(logCount(), n);
  assert.equal(history().length, 0);
  assert.equal(row().version, 5);
  assert.equal(row().audience, "Arabic readers");

  const empty = fresh({ prefs: false });
  assert.equal((await empty.put({ audience: "x" }, 3)).status, 409, "a first write must send If-Match: 0");
  assert.equal(empty.history().length, 0);
});

test("a 400 records nothing: bad JSON and a field that fails validation", async () => {
  const { put, logCount } = fresh();
  const n = logCount();
  assert.equal((await put("{not json", 5, { raw: true })).status, 400);
  assert.equal((await put({ register: "shouty" }, 5)).status, 400);
  assert.equal(logCount(), n);
});

test("the recorded previous values rebuild each prior row, back to the first save", async () => {
  const { put, row, history } = fresh({ prefs: false });
  const before = []; // before[i] = the fields just before save i (null: no row yet)
  const saves = [
    [{ audience: "Readers", instructions_md: "- One." }, {}],
    [{ instructions_md: "- One.\n- Two.", notes: "draft" }, { chat: true }],
    [{ register: "informal", notes: null }, {}],
    [{}, { chat: true }], // changes nothing; still a new version, still an entry
  ];
  for (const [body, opts] of saves) {
    const cur = row();
    before.push(cur ? pick(cur) : null);
    const r = await put(body, cur ? cur.version : 0, opts);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const newestFirst = history().reverse();
  assert.equal(newestFirst.length, saves.length);
  assert.deepEqual(newestFirst[0].payload.changed, {});
  assert.deepEqual(
    newestFirst.map((e) => e.source),
    ["chat", null, "chat", null],
  );
  // Walk back from the current row, undoing one entry at a time.
  let state = pick(row());
  for (let i = 0; i < newestFirst.length; i++) {
    const e = newestFirst[i];
    state = undo(state, e);
    const expected = before[saves.length - 1 - i];
    if (expected) assert.deepEqual(state, expected, `undoing v${e.new_version} gives v${e.prev_version}`);
    else {
      assert.equal(e.prev_version, 0, "the oldest entry is the first save");
      assert.deepEqual(state, { audience: null, purpose: null, register: "default", script_notes: null, instructions_md: null, common_issues_md: null, notes: null });
    }
  }
});

test("readers of edit_log are unaffected: a prefs save is not a person touching a note", async () => {
  const { sqlite, put, logCount } = fresh();
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, occurrence, sort_order, version, updated_by, translation_state)
       VALUES ('ab12', 'ZEC', 1, 1, '1:1', 'AI note', 1, 10, 1, 8, 'ai_draft')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
       VALUES ('tn', 'ab12', 'ZEC', 8, 0, 1, 'create', 'ai_pipeline')`,
    )
    .run();
  // A translate job queued now: its watermark is MAX(edit_log.id) (pipelines.ts).
  const watermark = Number(sqlite.prepare(`SELECT COALESCE(MAX(id), 0) AS w FROM edit_log`).get().w);
  const job = { edit_log_watermark: watermark, created_at: 0 };
  const touched = () =>
    sqlite.prepare(rowTouchedAfterJobSql("tn", true, 1)).all(...rowTouchedAfterJobBindings("ZEC", job, ["ab12"])).length > 0;
  const nonPrefs = () => Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log WHERE kind <> 'prefs'`).get().n);
  const n = nonPrefs();

  // Both a web (source NULL, 'update') and a chat ('chat') save: the shapes a
  // person's note edit has, so only the kind keeps them out.
  assert.equal((await put({ audience: "x" }, 5)).status, 200);
  assert.equal((await put({ audience: "y" }, 6, { chat: true })).status, 200);
  assert.equal(logCount(), n + 2);
  assert.equal(nonPrefs(), n);
  assert.equal(touched(), false, "the translate apply would still treat the note as untouched");
  // chapters.ts / rows.ts latest_source: still the AI's, so the AI chip stays.
  const latest = sqlite
    .prepare(`SELECT source FROM edit_log WHERE kind = 'tn' AND row_key = 'ab12' AND book = 'ZEC' ORDER BY id DESC LIMIT 1`)
    .get();
  assert.equal(latest.source, "ai_pipeline");

  // Control: a real note edit after the watermark IS seen, so the check above
  // is not empty by construction.
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
       VALUES ('tn', 'ab12', 'ZEC', 8, 1, 2, 'update', NULL)`,
    )
    .run();
  assert.equal(touched(), true);
});

// ---------------------------------------------------------------------------
// Issue #788: GET /prefs/history, and restore (client-side rebuild + PUT).
// ---------------------------------------------------------------------------

test("GET /prefs/history lists entries newest first with who, web or chat, and the parsed changes", async () => {
  const { put, getHistory } = fresh();
  assert.equal((await put({ register: "informal" }, 5)).status, 200);
  assert.equal((await put({ audience: "Young readers" }, 6, { chat: true })).status, 200);
  const r = await getHistory();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.current.version, 7);
  assert.equal(r.body.next, null);
  assert.equal(r.body.entries.length, 2);
  const [chat, web] = r.body.entries;
  assert.equal(chat.source, "chat");
  assert.equal(chat.username, "other-admin");
  assert.equal(chat.user_id, 9);
  assert.equal(chat.prev_version, 6);
  assert.equal(chat.new_version, 7);
  assert.equal(chat.action, "update");
  assert.deepEqual(chat.changed, { audience: { prev: "Arabic readers", new: "Young readers" } });
  assert.equal(typeof chat.created_at, "number");
  assert.equal("payload_json" in chat, false, "the raw payload is not sent");
  assert.equal(web.source, null);
  assert.equal(web.username, "boss");
  assert.deepEqual(web.changed, { register: { prev: "formal", new: "informal" } });
});

test("GET /prefs/history pages by id with `before`, and lists only preferences entries", async () => {
  const { sqlite, put, getHistory } = fresh();
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action) VALUES ('tn', '1', 'ZEC', 8, 1, 2, 'update')`,
    )
    .run();
  for (let v = 5; v < 10; v++) assert.equal((await put({ notes: `n${v}` }, v)).status, 200);
  const p1 = await getHistory("?limit=2");
  assert.deepEqual(
    p1.body.entries.map((e) => e.new_version),
    [10, 9],
  );
  assert.notEqual(p1.body.next, null);
  const p2 = await getHistory(`?limit=2&before=${p1.body.next}`);
  assert.deepEqual(
    p2.body.entries.map((e) => e.new_version),
    [8, 7],
  );
  const p3 = await getHistory(`?limit=2&before=${p2.body.next}`);
  assert.deepEqual(
    p3.body.entries.map((e) => e.new_version),
    [6],
  );
  assert.equal(p3.body.next, null);
  assert.equal((await getHistory("?before=abc")).status, 400);
});

test("GET /prefs/history marks an unreadable stored change as null, not as 'no changes'", async () => {
  const { sqlite, put, getHistory } = fresh();
  assert.equal((await put({ audience: "A" }, 5)).status, 200);
  sqlite.prepare(`UPDATE edit_log SET payload_json = '{not json' WHERE kind = 'prefs'`).run();
  const r = await getHistory();
  assert.equal(r.status, 200);
  assert.equal(r.body.entries[0].changed, null);
  assert.deepEqual(rebuildPrefsVersion(r.body.current, r.body.entries, 5), { ok: false, reason: "gap" });
});

test("GET /prefs/history with nothing saved is empty at version 0", async () => {
  const { getHistory } = fresh({ prefs: false });
  const r = await getHistory();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.entries, []);
  assert.equal(r.body.current.version, 0);
  assert.equal(r.body.next, null);
});

test("GET /prefs/history is admin-only", async () => {
  const { getHistory } = fresh({ role: "editor" });
  assert.equal((await getHistory()).status, 403);
});

// The issue's success check: two saves, then restoring the first leaves the row
// equal to the first version and adds a third history entry.
test("restore: two saves, then restoring the first version puts it back as a third entry", async () => {
  const { put, row, history, getHistory } = fresh({ prefs: false });
  assert.equal((await put({ audience: "Readers", instructions_md: "- One." }, 0)).status, 200);
  const v1 = pick(row());
  assert.equal(
    (await put({ audience: "Children", instructions_md: "- Two.", register: "informal" }, 1, { chat: true })).status,
    200,
  );
  assert.notDeepEqual(pick(row()), v1);

  const h = await getHistory();
  const rebuilt = rebuildPrefsVersion(h.body.current, h.body.entries, 1);
  assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt));
  const r = await put(rebuilt.fields, h.body.current.version);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  assert.deepEqual(pick(row()), v1, "the row is the first version again");
  assert.equal(row().version, 3, "the restore is a new version");
  const entries = history();
  assert.equal(entries.length, 3, "the restore is recorded as a third entry");
  assert.equal(entries[2].source, null);
  assert.equal(entries[2].prev_version, 2);
  assert.deepEqual(entries[2].payload.changed, {
    audience: { prev: "Children", new: "Readers" },
    register: { prev: "informal", new: "default" },
    instructions_md: { prev: "- Two.", new: "- One." },
  });
});

test("restore: a save after the history was read makes the restore 409 or refuse, never misrestore", async () => {
  const { put, row, getHistory } = fresh();
  assert.equal((await put({ audience: "A" }, 5)).status, 200);
  assert.equal((await put({ audience: "B" }, 6)).status, 200);
  const h = await getHistory();
  // Someone saves between reading the list and pressing Restore.
  assert.equal((await put({ audience: "C" }, 7, { chat: true })).status, 200);
  const rebuilt = rebuildPrefsVersion(h.body.current, h.body.entries, 6);
  assert.equal(rebuilt.ok, true);
  const r = await put(rebuilt.fields, h.body.current.version);
  assert.equal(r.status, 409, "the stale If-Match is refused");
  assert.equal(row().audience, "C", "the newer save stands");
  // A fresh list reads the new save and rebuilds correctly.
  const h2 = await getHistory();
  const again = rebuildPrefsVersion(h2.body.current, h2.body.entries, 6);
  assert.equal(again.ok, true);
  assert.equal(again.fields.audience, "A");
  // A current row newer than the list (the other read order) is refused outright.
  const ahead = { ...h2.body.current, version: h2.body.current.version + 1 };
  assert.deepEqual(rebuildPrefsVersion(ahead, h2.body.entries, 6), { ok: false, reason: "stale" });
});
