// Tests for switching a tN note kind off and back on (issue #924,
// api/src/noteKindSwitch.ts, migration 0090).
//
// Against the REAL schema (every file in api/migrations applied in order to
// node:sqlite), through the suggestionInbox app as index.ts mounts it, and the
// REAL reimport functions (applyTsvRows, softDeleteRemovedTsvRows). The
// nightly finalize is its exact two statements from api/src/index.ts.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/noteKindSwitch.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { suggestionInbox } from "./suggestionInbox.ts";
import { hideSwitchedOffKinds } from "./noteKindSwitch.ts";
import { applyTsvRows, changedTsvChapters, softDeleteRemovedTsvRows } from "./bookReimport.ts";
import { buildTnTsv, exportTsvShrinkRefused } from "./export.ts";

const NOW = Math.floor(Date.now() / 1000);
const YOU = "rc://*/ta/man/translate/figs-yousingular";
const YOU_ID = "figs-yousingular";
const OTHER = "rc://*/ta/man/translate/figs-metaphor";

function makeDb(sqlite) {
  const mk = (sql, args) => ({
    sql,
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
  // D1 runs a batch as one transaction.
  return {
    prepare: (sql) => mk(sql, []),
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

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'boss')`).run();

  const app = new Hono();
  let role = "admin";
  app.use("*", async (c, next) => {
    c.set("userId", 1);
    c.set("role", role);
    await next();
  });
  app.route("/api/suggestion-inbox", suggestionInbox);
  const env = { DB: makeDb(sqlite) };
  const call = async (method, path, body) => {
    const res = await app.request(
      `/api/suggestion-inbox${path}`,
      { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
      env,
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  let seq = 0;
  const note = ({ book = "ZEC", chapter = 1, verse = 1, kind = YOU, deletedAt = null, trashedAt = null } = {}) => {
    const id = `k${String(++seq).padStart(3, "0")}`;
    sqlite
      .prepare(
        `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, support_reference, note, version, deleted_at, trashed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, book, chapter, verse, `${chapter}:${verse}`, kind, `note ${id}`, deletedAt, trashedAt);
    return id;
  };
  // Enough trash marks for the part A card to list YOU (10 notes, 3 chapters),
  // so switch-off (which takes only a listed kind) accepts it.
  const listYou = () => {
    for (let i = 0; i < 10; i++) {
      const id = note({ chapter: (i % 3) + 1, trashedAt: NOW - 100 });
      sqlite
        .prepare(`INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action) VALUES ('tn', ?, 'ZEC', 1, 1, 1, 'trash')`)
        .run(id);
    }
  };
  const finalize = () => {
    sqlite.exec(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
       SELECT 'tn', id, book, NULL, version, version, 'delete', 'nightly_finalize'
         FROM tn_rows WHERE trashed_at IS NOT NULL AND deleted_at IS NULL`,
    );
    sqlite.exec(
      `UPDATE tn_rows SET deleted_at = trashed_at, trashed_at = NULL
        WHERE trashed_at IS NOT NULL AND deleted_at IS NULL`,
    );
  };
  const row = (id, book = "ZEC") => sqlite.prepare(`SELECT * FROM tn_rows WHERE id = ? AND book = ?`).get(id, book);
  const logs = (action) => sqlite.prepare(`SELECT * FROM edit_log WHERE action = ? ORDER BY id`).all(action);
  // The editor's reads and the export's read all leave out deleted_at rows;
  // this is the export's tn read (exportWorkflow.ts buildResource), re-typed.
  const exportRows = (book) =>
    sqlite.prepare(`SELECT * FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL AND trashed_at IS NULL ORDER BY chapter, verse, id`).all(book);
  return { sqlite, env, call, note, listYou, finalize, row, logs, exportRows, setRole: (r) => (role = r) };
}

test("switch off hides every live note of the kind, in every book, with one edit_log row each", async () => {
  const h = fixture();
  h.listYou();
  const live = [
    h.note({ book: "ZEC", chapter: 4 }),
    h.note({ book: "ZEC", chapter: 5, kind: YOU_ID }), // bare id form
    h.note({ book: "HAG", chapter: 1, kind: `  ${YOU}  ` }), // stray spaces
  ];
  const other = h.note({ chapter: 4, kind: OTHER });
  const lookalike = h.note({ chapter: 4, kind: "rc://*/ta/man/translate/x-figs-yousingular" });
  const deletedBefore = h.note({ chapter: 6, deletedAt: NOW - 5000 });
  const trashed = h.note({ chapter: 6, trashedAt: NOW - 50 });

  const r = await h.call("POST", "/not-needed-kinds/switch-off", { kind: YOU_ID });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.hidden, 3);

  for (const id of live.slice(0, 2)) {
    assert.ok(h.row(id).deleted_at, `${id} hidden`);
    assert.equal(h.row(id).switched_off_kind, YOU_ID);
  }
  assert.equal(h.row(live[2], "HAG").switched_off_kind, YOU_ID);
  assert.equal(h.row(other).deleted_at, null, "another kind is untouched");
  assert.equal(h.row(lookalike).deleted_at, null, "a kind that only ends with the id is untouched");
  assert.equal(h.row(deletedBefore).switched_off_kind, null, "an already deleted note gets no mark");
  assert.equal(h.row(trashed).switched_off_kind, null, "a trashed note keeps the trash path");
  assert.equal(h.row(trashed).deleted_at, null);

  const offLogs = h.logs("switch_off");
  assert.equal(offLogs.length, 3, "one edit_log row per hidden note");
  assert.deepEqual(offLogs.map((l) => l.row_key).sort(), [...live].sort());
  assert.ok(offLogs.every((l) => l.user_id === 1 && l.source === "note_kind_switch"));

  assert.deepEqual(h.exportRows("ZEC").map((x) => x.id), [other, lookalike], "the export read leaves the hidden notes out");
  const tsv = buildTnTsv(h.exportRows("ZEC"));
  assert.ok(live.every((id) => !tsv.includes(`\t${id}\t`)), "the rendered TSV has none of the hidden notes");

  const list = await h.call("GET", "/not-needed-kinds");
  assert.equal(list.status, 200);
  assert.equal(list.body.switchNotMigrated, false);
  assert.deepEqual(list.body.kinds, [], "a switched-off kind leaves the Not needed list");
  assert.deepEqual(list.body.switchedOff.map((k) => [k.kind, k.hidden]), [[YOU_ID, 3]]);
});

test("switch back on restores exactly the hidden notes, after the nightly finalize too", async () => {
  const h = fixture();
  h.listYou();
  const live = [h.note({ chapter: 4 }), h.note({ chapter: 5 }), h.note({ book: "HAG" })];
  const deletedBefore = h.note({ chapter: 6, deletedAt: NOW - 5000 });
  const trashed = h.note({ chapter: 6, trashedAt: NOW - 50 });
  await h.call("POST", "/not-needed-kinds/switch-off", { kind: YOU_ID });

  h.finalize();
  for (const id of live.slice(0, 2)) assert.equal(h.row(id).switched_off_kind, YOU_ID, "the finalize leaves the mark alone");
  assert.ok(h.row(trashed).deleted_at, "the finalize still deletes trash as usual");

  const r = await h.call("POST", "/not-needed-kinds/switch-on", { kind: YOU_ID });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.restored, 3);
  for (const id of live.slice(0, 2)) {
    assert.equal(h.row(id).deleted_at, null, `${id} restored`);
    assert.equal(h.row(id).switched_off_kind, null);
    assert.ok(h.row(id).switch_restored_at);
    assert.equal(h.row(id).version, 1, "no version bump: a state flip, like trash");
  }
  assert.equal(h.row(live[2], "HAG").deleted_at, null);
  assert.ok(h.row(deletedBefore).deleted_at, "a note deleted before the switch-off stays deleted");
  assert.ok(h.row(trashed).deleted_at, "a finalized trashed note stays deleted");
  assert.equal(h.logs("switch_on").length, 3, "one edit_log row per restored note");

  const list = await h.call("GET", "/not-needed-kinds");
  assert.deepEqual(list.body.switchedOff, []);
  const again = await h.call("POST", "/not-needed-kinds/switch-on", { kind: YOU_ID });
  assert.equal(again.status, 404, "a kind that is not switched off cannot be switched on");
});

test("non-admins get 403; bad and unlisted kinds are refused", async () => {
  const h = fixture();
  h.listYou();
  h.setRole("editor");
  assert.equal((await h.call("POST", "/not-needed-kinds/switch-off", { kind: YOU_ID })).status, 403);
  assert.equal((await h.call("POST", "/not-needed-kinds/switch-on", { kind: YOU_ID })).status, 403);
  assert.equal(h.logs("switch_off").length, 0);
  h.setRole("admin");
  assert.equal((await h.call("POST", "/not-needed-kinds/switch-off", { kind: "a/b" })).status, 400);
  assert.equal((await h.call("POST", "/not-needed-kinds/switch-off", {})).status, 400);
  assert.equal((await h.call("POST", "/not-needed-kinds/switch-off", { kind: "figs-metaphor" })).status, 404, "only a listed kind");
});

test("a reimport does not bring the kind back: same-ref master rows stay hidden, new ones are hidden and marked", async () => {
  const h = fixture();
  h.listYou();
  const hidden = h.note({ chapter: 4, verse: 2 });
  await h.call("POST", "/not-needed-kinds/switch-off", { kind: YOU_ID });

  // Master still carries the hidden note (tonight's export has not run) and a
  // new note of the kind.
  const master = (id, verse) => ({
    id, idCoerced: false, refRaw: `4:${verse}`, chapter: 4, verse,
    occurrence: null, tags: null, support_reference: YOU, quote: null, note: `note ${id}`,
  });
  await applyTsvRows(h.env, "ZEC", "tn", [master(hidden, 2), master("zz01", 3)], null);
  assert.ok(h.row(hidden).deleted_at, "the hidden note is not brought back");
  assert.equal(h.row("zz01").deleted_at, null, "the reimport inserts the new note");
  assert.equal(await hideSwitchedOffKinds(h.env.DB, { book: "ZEC" }), 1);
  assert.ok(h.row("zz01").deleted_at, "the post-pass hides it");
  assert.equal(h.row("zz01").switched_off_kind, YOU_ID, "marked, so Switch back on restores it too");
  assert.equal(h.logs("switch_off").length, 2);

  // A hidden note whose last 'delete' log entry was an old reimport prune is
  // a resurrect candidate by its columns; the mark must keep it hidden.
  h.sqlite
    .prepare(`INSERT INTO edit_log (kind, row_key, book, action, source) VALUES ('tn', ?, 'ZEC', 'delete', 'dcs_reimport')`)
    .run(hidden);
  const counts = await applyTsvRows(h.env, "ZEC", "tn", [master(hidden, 2)], null);
  assert.ok(h.row(hidden).deleted_at, "not resurrected");
  assert.equal(counts.tombstone_resurrected ?? 0, 0);

  // The prune leaves hidden notes alone (they are not live).
  const tsv = buildTnTsv([{ ref_raw: "4:9", id: "zz02", tags: null, support_reference: OTHER, quote: null, occurrence: null, note: "n" }]);
  h.note({ chapter: 4, verse: 9, kind: OTHER });
  await softDeleteRemovedTsvRows(h.env, "ZEC", "tn", tsv, [4]);
  assert.equal(h.row(hidden).switched_off_kind, YOU_ID, "still marked after a prune of its chapter");

  const on = await h.call("POST", "/not-needed-kinds/switch-on", { kind: YOU_ID });
  assert.equal(on.body.restored, 2, "both the original and the reimported note come back");
});

test("after Switch back on, the reimport's prune keeps restored notes until master carries them", async () => {
  const h = fixture();
  h.listYou();
  const a = h.note({ chapter: 4, verse: 2 });
  const keep = h.note({ chapter: 4, verse: 5, kind: OTHER });
  await h.call("POST", "/not-needed-kinds/switch-off", { kind: YOU_ID });
  await h.call("POST", "/not-needed-kinds/switch-on", { kind: YOU_ID });

  // Master as the export left it while the kind was off: without `a`.
  const without = buildTnTsv([h.row(keep)]);
  const r = await softDeleteRemovedTsvRows(h.env, "ZEC", "tn", without, [4]);
  assert.equal(r.deleted, 0);
  assert.equal(h.row(a).deleted_at, null, "the restored note survives the prune");
  assert.ok(h.row(a).switch_restored_at, "still waiting for master");

  // Tonight's export puts it back on master; the next prune clears the wait.
  const withIt = buildTnTsv([h.row(keep), h.row(a)]);
  await softDeleteRemovedTsvRows(h.env, "ZEC", "tn", withIt, [4]);
  assert.equal(h.row(a).switch_restored_at, null, "an ordinary note again");
  assert.equal(h.row(a).deleted_at, null);

  // From then on, master removing it is an ordinary removal.
  await softDeleteRemovedTsvRows(h.env, "ZEC", "tn", without, [4]);
  assert.ok(h.row(a).deleted_at, "pruned like any note once master has carried it");
});

test("the nightly sync's chapter diff clears the restore wait once master carries the note", async () => {
  const h = fixture();
  h.listYou();
  const a = h.note({ chapter: 4, verse: 2 });
  await h.call("POST", "/not-needed-kinds/switch-off", { kind: YOU_ID });
  await h.call("POST", "/not-needed-kinds/switch-on", { kind: YOU_ID });
  assert.ok(h.row(a).switch_restored_at);
  // Master now equals D1 for chapter 4 (the export put the note back), so the
  // diff reports no change there and the prune would not run.
  const tsv = buildTnTsv(h.sqlite.prepare(`SELECT * FROM tn_rows WHERE book = 'ZEC' AND deleted_at IS NULL AND trashed_at IS NULL`).all());
  const changed = await changedTsvChapters(h.env, "ZEC", "tn", tsv);
  assert.ok(!changed.has(4), "chapter 4 unchanged");
  assert.equal(h.row(a).switch_restored_at, null, "the wait is cleared anyway");
});

test("the nightly pass hides notes of a switched-off kind written since, in every book", async () => {
  const h = fixture();
  h.listYou();
  await h.call("POST", "/not-needed-kinds/switch-off", { kind: YOU_ID });
  const later = [h.note({ chapter: 7 }), h.note({ book: "MAL" })];
  assert.equal(await hideSwitchedOffKinds(h.env.DB), 2);
  assert.ok(h.row(later[0]).deleted_at && h.row(later[1], "MAL").deleted_at);
  assert.equal(await hideSwitchedOffKinds(h.env.DB), 0, "nothing left to hide");
});

test("known limit: hiding many notes of one book trips the export's whole-file shrink guard", () => {
  // checkTsvShrink (exportWorkflow.ts) refuses a whole-book tN commit that
  // drops more than 25 rows and more than 5% of master's rows, with no override.
  // So switching off a kind with that many notes in a book holds that book's
  // export until someone decides how the guard should treat a switch-off.
  assert.equal(exportTsvShrinkRefused(940, 1000), true, "60 of 1000 hidden: refused");
  assert.equal(exportTsvShrinkRefused(960, 1000), false, "40 of 1000 hidden: allowed");
  assert.equal(exportTsvShrinkRefused(170, 200), true, "30 of 200 hidden: refused");
});
