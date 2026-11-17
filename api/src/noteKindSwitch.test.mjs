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
import {
  dropRestoredKeptNotes,
  hideSwitchedOffKinds,
  keptNoteHoldsRow,
  keptSwitchedOffNotes,
  restoredKeptNotesMasterCarries,
  tnShrinkCheck,
  TN_WIPE_SQL,
} from "./noteKindSwitch.ts";
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

// ── The nightly export's shrink guard ignores notes switched off on purpose ──
// (Benjamin's option A on #924.) tnShrinkCheck is what exportWorkflow.ts
// checkTsvShrink runs for tN: a row missing from the render is exempt only when
// D1 marks that exact (book, id) as switched off AND master's row is of that
// kind. The >25-and->5% limit then applies to master without the exempt rows.

// A ZEC book on master: `other` notes of OTHER and `you` notes of YOU, all
// live in D1. Returns the IDs and master's TSV (rendered from D1 now).
function seedBook(h, { other, you }) {
  const otherIds = Array.from({ length: other }, (_, i) => h.note({ chapter: (i % 9) + 1, verse: (i % 7) + 1, kind: OTHER }));
  const youIds = Array.from({ length: you }, (_, i) => h.note({ chapter: (i % 9) + 1, verse: (i % 7) + 1 }));
  return { otherIds, youIds, master: buildTnTsv(h.exportRows("ZEC")) };
}
// Delete notes the ordinary way (no switch-off mark): an unexplained drop.
const plainDelete = (h, ids) => {
  for (const id of ids) h.sqlite.prepare(`UPDATE tn_rows SET deleted_at = ? WHERE id = ? AND book = 'ZEC'`).run(NOW, id);
};
const render = (h) => buildTnTsv(h.exportRows("ZEC"));
const switchOffYou = async (h) => {
  h.listYou(); // trashed notes only: never live, never on master
  const r = await h.call("POST", "/not-needed-kinds/switch-off", { kind: YOU_ID });
  assert.equal(r.status, 200);
};

test("shrink guard: a switched-off kind larger than the limit still publishes", async () => {
  const h = fixture();
  const { master } = seedBook(h, { other: 200, you: 40 });
  await switchOffYou(h);
  // Without the exemption this is 40 of 240 (17%): refused.
  assert.equal(exportTsvShrinkRefused(200, 240), true, "the plain count would refuse");
  const r = await tnShrinkCheck(h.env.DB, "ZEC", master, render(h));
  assert.deepEqual(r, { refused: false, masterRows: 240, renderedRows: 200, exempt: 40 });
});

test("shrink guard: an unexplained drop of the same size is still refused", async () => {
  const h = fixture();
  const { master, youIds } = seedBook(h, { other: 200, you: 40 });
  plainDelete(h, youIds); // same rows, same kind, but no switch-off mark
  const r = await tnShrinkCheck(h.env.DB, "ZEC", master, render(h));
  assert.deepEqual(r, { refused: true, masterRows: 240, renderedRows: 200, exempt: 0 });
});

test("shrink guard: switched-off plus unexplained drops are decided on the unexplained part alone", async () => {
  // Refused: 40 switched off (exempt) + 30 unexplained of the remaining 200 (15%).
  {
    const h = fixture();
    const { master, otherIds } = seedBook(h, { other: 200, you: 40 });
    await switchOffYou(h);
    plainDelete(h, otherIds.slice(0, 30));
    const r = await tnShrinkCheck(h.env.DB, "ZEC", master, render(h));
    assert.deepEqual(r, { refused: true, masterRows: 240, renderedRows: 170, exempt: 40 });
  }
  // Allowed: 40 switched off + 20 unexplained = 60 together (over the limit),
  // but 20 alone is under the 25-row floor.
  {
    const h = fixture();
    const { master, otherIds } = seedBook(h, { other: 200, you: 40 });
    await switchOffYou(h);
    plainDelete(h, otherIds.slice(0, 20));
    assert.equal(exportTsvShrinkRefused(180, 240), true, "the plain count would refuse");
    const r = await tnShrinkCheck(h.env.DB, "ZEC", master, render(h));
    assert.deepEqual(r, { refused: false, masterRows: 240, renderedRows: 180, exempt: 40 });
  }
});

test("shrink guard: rows of a switched-off kind that D1 never marked are not exempt (partial load)", async () => {
  // The kind is switched off, and master carries 40 notes of it that D1 does
  // not hold at all (a truncated load): the kind matches, the identity does not.
  const h = fixture();
  await switchOffYou(h);
  seedBook(h, { other: 200, you: 0 });
  const lines = render(h).trimEnd().split("\n");
  for (let i = 0; i < 40; i++) lines.push(["1:1", `m${String(i).padStart(3, "0")}`, "", YOU, "", "0", "lost"].join("\t"));
  const master = lines.join("\n") + "\n";
  const r = await tnShrinkCheck(h.env.DB, "ZEC", master, render(h));
  assert.deepEqual(r, { refused: true, masterRows: 240, renderedRows: 200, exempt: 0 });
});

test("shrink guard: switched-off notes that were never on master give no headroom", async () => {
  const h = fixture();
  const { otherIds } = seedBook(h, { other: 200, you: 0 });
  const master = render(h); // 200 rows, none of them YOU
  h.note({ chapter: 2 }); // 40 YOU notes land after master was written ...
  for (let i = 1; i < 40; i++) h.note({ chapter: 3 });
  await switchOffYou(h); // ... and are switched off before any export
  plainDelete(h, otherIds.slice(0, 30)); // 30 of 200 (15%) dropped unexplained
  const r = await tnShrinkCheck(h.env.DB, "ZEC", master, render(h));
  assert.deepEqual(r, { refused: true, masterRows: 200, renderedRows: 170, exempt: 0 });
});

test("shrink guard: a marked ID whose master row is another kind is not exempt", async () => {
  const h = fixture();
  const { master, youIds } = seedBook(h, { other: 200, you: 40 });
  await switchOffYou(h);
  // Master's copy of those IDs says OTHER, not the kind D1 hid them for.
  const swapped = master.split(YOU).join(OTHER);
  assert.ok(youIds.length === 40);
  const r = await tnShrinkCheck(h.env.DB, "ZEC", swapped, render(h));
  assert.deepEqual(r, { refused: true, masterRows: 240, renderedRows: 200, exempt: 0 });
});

test("shrink guard: only marks in this book count", async () => {
  const h = fixture();
  const { master } = seedBook(h, { other: 200, you: 40 });
  await switchOffYou(h);
  // Move the marks to another book: the same IDs in ZEC are no longer marked.
  h.sqlite.exec(`UPDATE tn_rows SET book = 'MAL' WHERE book = 'ZEC' AND switched_off_kind IS NOT NULL`);
  const r = await tnShrinkCheck(h.env.DB, "ZEC", master, render(h));
  assert.deepEqual(r, { refused: true, masterRows: 240, renderedRows: 200, exempt: 0 });
});

test("shrink guard: a master file without ID or SupportReference columns gets no exemption", async () => {
  const h = fixture();
  const { master } = seedBook(h, { other: 200, you: 40 });
  await switchOffYou(h);
  const noHeader = master.replace(/^Reference\tID\t/, "Reference\tRowId\t");
  const r = await tnShrinkCheck(h.env.DB, "ZEC", noHeader, render(h));
  assert.equal(r.refused, true);
  assert.equal(r.exempt, 0);
});

// ── D1 bounds (review round 1) ──────────────────────────────────────────────
// Wrap a fixture's DB to count D1 calls (each all/first/run outside a batch,
// and each batch) and record every batch's statement count.
function counted(db) {
  const stats = { calls: 0, batchSizes: [] };
  const wrap = (stmt) => ({
    ...stmt,
    bind: (...a) => wrap(stmt.bind(...a)),
    all: async () => (stats.calls++, stmt.all()),
    first: async () => (stats.calls++, stmt.first()),
    run: () => (stats.calls++, stmt.run()),
    _raw: stmt,
  });
  return {
    stats,
    db: {
      prepare: (sql) => wrap(db.prepare(sql)),
      async batch(stmts) {
        stats.calls++;
        stats.batchSizes.push(stmts.length);
        return db.batch(stmts.map((s) => s._raw ?? s));
      },
    },
  };
}

test("hiding new notes of 60 switched-off kinds stays under D1's 100 statements per batch", async () => {
  const h = fixture();
  for (let i = 0; i < 60; i++) {
    const kind = `figs-kind${i}`;
    h.sqlite.prepare(`INSERT INTO note_kinds_switched_off (kind, switched_off_at) VALUES (?, ?)`).run(kind, NOW);
    h.note({ chapter: (i % 9) + 1, kind: `rc://*/ta/man/translate/${kind}` });
  }
  const c = counted(h.env.DB);
  assert.equal(await hideSwitchedOffKinds(c.db), 60, "every kind's note hidden");
  assert.ok(c.stats.batchSizes.length >= 2, "split into several batches");
  assert.ok(Math.max(...c.stats.batchSizes) <= 100, `largest batch ${Math.max(...c.stats.batchSizes)}`);
  assert.ok(c.stats.batchSizes.every((n) => n % 2 === 0), "INSERT/UPDATE pairs kept together");
  assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM tn_rows WHERE switched_off_kind IS NOT NULL AND deleted_at IS NOT NULL`).get().n, 60);
});

test("clearing the restore wait on 500 restored notes takes a bounded number of D1 calls", async () => {
  // Chapter diff (changedTsvChapters) and the prune (softDeleteRemovedTsvRows)
  // both clear switch_restored_at once master carries the note again.
  for (const path of ["diff", "prune"]) {
    const h = fixture();
    const ids = Array.from({ length: 500 }, () => h.note({ chapter: 4, verse: 1, kind: OTHER }));
    h.sqlite.exec(`UPDATE tn_rows SET switch_restored_at = ${NOW} WHERE book = 'ZEC'`);
    const tsv = buildTnTsv(h.exportRows("ZEC"));
    const c = counted(h.env.DB);
    const env = { ...h.env, DB: c.db };
    if (path === "diff") await changedTsvChapters(env, "ZEC", "tn", tsv);
    else await softDeleteRemovedTsvRows(env, "ZEC", "tn", tsv, [4]);
    assert.equal(
      h.sqlite.prepare(`SELECT COUNT(*) n FROM tn_rows WHERE book = 'ZEC' AND switch_restored_at IS NOT NULL`).get().n,
      0,
      `${path}: every wait cleared`,
    );
    assert.ok(c.stats.calls <= 10, `${path}: ${c.stats.calls} D1 calls for ${ids.length} notes`);
    assert.ok(Math.max(0, ...c.stats.batchSizes) <= 100, `${path}: batch size bounded`);
  }
});

test("a fresh book import's wipe keeps switched-off notes and restored-not-yet-exported ones", async () => {
  // bookImport.ts runs TN_WIPE_SQL, then insertTnRows skips master's row for
  // a kept note (keptNoteHoldsRow) and re-mints any other row sharing its id
  // (bookImport.ts is not loadable under node's strip-types runner, so the
  // insert loop itself is not run here).
  const h = fixture();
  const { youIds, otherIds } = seedBook(h, { other: 3, you: 3 });
  await switchOffYou(h);
  // An earlier Switch back on restored this note; no export has run since.
  const restored = otherIds[0];
  h.sqlite.prepare(`UPDATE tn_rows SET switch_restored_at = ? WHERE id = ? AND book = 'ZEC'`).run(NOW, restored);
  // Two more restored notes that are no longer live: one marked Not needed
  // (trashed), one finalized since (deleted). Neither is kept.
  const [trashedRestored, deletedRestored] = [h.note({ chapter: 6, kind: OTHER }), h.note({ chapter: 6, kind: OTHER })];
  h.sqlite.prepare(`UPDATE tn_rows SET switch_restored_at = ?1, trashed_at = ?1 WHERE id = ?2 AND book = 'ZEC'`).run(NOW, trashedRestored);
  h.sqlite.prepare(`UPDATE tn_rows SET switch_restored_at = ?1, deleted_at = ?1 WHERE id = ?2 AND book = 'ZEC'`).run(NOW, deletedRestored);
  h.sqlite.prepare(TN_WIPE_SQL).run("ZEC");
  for (const id of otherIds.slice(1)) assert.equal(h.row(id), undefined, `${id} wiped`);
  assert.equal(h.row(trashedRestored), undefined, "a restored note since trashed is wiped");
  assert.equal(h.row(deletedRestored), undefined, "a restored note since deleted is wiped");
  assert.ok(h.row(restored), "a restored note master lacks survives the wipe");
  for (const id of youIds) assert.equal(h.row(id).switched_off_kind, YOU_ID, `${id} kept, hidden and marked`);
  const kept = await keptSwitchedOffNotes(h.env.DB, "ZEC");
  assert.deepEqual([...kept.keys()].sort(), [...youIds, restored].sort());
  assert.equal(kept.get(youIds[0]).kind, YOU_ID);
  assert.equal(kept.get(restored).kind, "figs-metaphor", "a restored note's kind is its own SupportReference");
  assert.equal((await keptSwitchedOffNotes(h.env.DB, "HAG")).size, 0, "per book");
  const on = await h.call("POST", "/not-needed-kinds/switch-on", { kind: YOU_ID });
  assert.equal(on.body.restored, 3, "Switch back on restores them");
});

test("a kept note holds master's row only when it is the same note", () => {
  const kept = { chapter: 4, verse: 2, kind: YOU_ID };
  assert.equal(keptNoteHoldsRow(kept, { chapter: 4, verse: 2, supportReference: YOU }), true, "same note: skipped");
  assert.equal(keptNoteHoldsRow(kept, { chapter: 4, verse: 2, supportReference: YOU_ID }), true, "bare id form");
  assert.equal(keptNoteHoldsRow(kept, { chapter: 4, verse: 3, supportReference: YOU }), false, "other verse: re-minted");
  assert.equal(keptNoteHoldsRow(kept, { chapter: 5, verse: 2, supportReference: YOU }), false, "other chapter: re-minted");
  assert.equal(keptNoteHoldsRow(kept, { chapter: 4, verse: 2, supportReference: OTHER }), false, "other kind: re-minted");
  assert.equal(keptNoteHoldsRow(kept, { chapter: 4, verse: 2, supportReference: null }), false, "no kind: re-minted");
  assert.equal(keptNoteHoldsRow(undefined, { chapter: 4, verse: 2, supportReference: YOU }), false, "no kept note");
  assert.equal(keptNoteHoldsRow({ chapter: 4, verse: 2, kind: "" }, { chapter: 4, verse: 2, supportReference: "" }), false, "kept note with no kind never matches");
});

test("a kind switched back on during a hide pass is not hidden again", async () => {
  const h = fixture();
  await switchOffYou(h);
  const fresh = h.note({ chapter: 8 }); // a new live note of the kind
  // The pass reads the list, then an admin switches the kind back on before
  // the hide batch runs.
  const db = h.env.DB;
  const racing = {
    prepare: (sql) => db.prepare(sql),
    async batch(stmts) {
      h.sqlite.exec(`DELETE FROM note_kinds_switched_off`);
      return db.batch(stmts);
    },
  };
  assert.equal(await hideSwitchedOffKinds(racing), 0);
  assert.equal(h.row(fresh).deleted_at, null, "still live");
  assert.equal(h.row(fresh).switched_off_kind, null, "no orphan mark");
  assert.equal(h.logs("switch_off").filter((l) => l.row_key === fresh).length, 0, "no audit row");
});

test("shrink guard: a duplicated master id counts its switched-off note once", async () => {
  const h = fixture();
  const { master, youIds } = seedBook(h, { other: 200, you: 20 });
  await switchOffYou(h);
  // Master repeats each switched-off note's line twice more: 60 lines for 20 notes.
  const extra = master.trimEnd().split("\n").filter((l) => youIds.includes(l.split("\t")[1]));
  const doubled = master + [...extra, ...extra].join("\n") + "\n";
  const r = await tnShrinkCheck(h.env.DB, "ZEC", doubled, render(h));
  assert.equal(r.exempt, 20, "each marked note once");
  assert.equal(r.masterRows, 260);
  assert.equal(r.refused, true, "the 40 repeated lines are unexplained");
});

test("fresh import: master's row replaces a restored-only kept note it carries; hidden notes stay", async () => {
  const h = fixture();
  const { youIds, otherIds } = seedBook(h, { other: 3, you: 1 });
  await switchOffYou(h);
  const [restored, restoredGone] = otherIds; // both restored by an earlier switch-on
  h.sqlite.prepare(`UPDATE tn_rows SET switch_restored_at = ? WHERE book = 'ZEC' AND id IN (?, ?)`).run(NOW, restored, restoredGone);
  const rowOf = (id) => ({ id, chapter: h.row(id).chapter, verse: h.row(id).verse, supportReference: h.row(id).support_reference });
  h.sqlite.prepare(TN_WIPE_SQL).run("ZEC");
  const kept = await keptSwitchedOffNotes(h.env.DB, "ZEC");
  assert.equal(kept.get(restored).restoredOnly, true);
  assert.equal(kept.get(youIds[0]).restoredOnly, false);
  // Master carries `restored` and the hidden note as the same notes (twice for
  // `restored`: first row wins, listed once), but not `restoredGone`, and
  // carries `restoredGone`'s id at another verse (a different note).
  const incoming = [
    rowOf(restored),
    rowOf(restored),
    rowOf(youIds[0]),
    { ...rowOf(restoredGone), verse: rowOf(restoredGone).verse + 1 },
  ];
  const replaced = restoredKeptNotesMasterCarries(kept, incoming);
  assert.deepEqual(replaced, [restored], "only the restored note master carries as the same note");
  await dropRestoredKeptNotes(h.env.DB, "ZEC", [...replaced, youIds[0]]);
  assert.equal(h.row(restored), undefined, "dropped: master's row is inserted in its place");
  assert.ok(h.row(youIds[0]), "a hidden note is never dropped, even if asked");
  assert.ok(h.row(restoredGone), "a restored note master lacks stays");
  const c = counted(h.env.DB);
  await dropRestoredKeptNotes(c.db, "ZEC", []);
  assert.equal(c.stats.calls, 0, "no D1 call for nothing");
});

test("hideSwitchedOffKinds: never throws by default; throwOnError fails the Workflow step instead", async () => {
  const h = fixture();
  await switchOffYou(h);
  h.note({ chapter: 8 });
  const failing = {
    prepare: (sql) => h.env.DB.prepare(sql),
    async batch() {
      throw new Error("D1_ERROR: network connection lost");
    },
  };
  assert.equal(await hideSwitchedOffKinds(failing, { book: "ZEC" }), 0, "default: logs and returns 0");
  await assert.rejects(hideSwitchedOffKinds(failing, { book: "ZEC", throwOnError: true }), /network connection lost/);
  // A database without migration 0090 is not an error in either mode.
  const old = { prepare: () => ({ all: async () => { throw new Error("no such table: note_kinds_switched_off"); } }) };
  assert.equal(await hideSwitchedOffKinds(old, { throwOnError: true }), 0);
});

test("switch-off answers 503 not_migrated when the switch-off itself finds no migration 0090", async () => {
  const h = fixture();
  h.listYou();
  const batch = h.env.DB.batch;
  h.env.DB.batch = async () => {
    throw new Error("no such table: note_kinds_switched_off");
  };
  try {
    const r = await h.call("POST", "/not-needed-kinds/switch-off", { kind: YOU_ID });
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { error: "not_migrated" });
  } finally {
    h.env.DB.batch = batch;
  }
});

test("kept notes and master rows compare chapter/verse as numbers, front:intro as 0:0", async () => {
  const h = fixture();
  const intro = h.note({ chapter: 0, verse: 0 });
  h.sqlite.prepare(`UPDATE tn_rows SET ref_raw = 'front:intro' WHERE id = ? AND book = 'ZEC'`).run(intro);
  await switchOffYou(h);
  const kept = await keptSwitchedOffNotes(h.env.DB, "ZEC");
  assert.deepEqual({ chapter: kept.get(intro).chapter, verse: kept.get(intro).verse }, { chapter: 0, verse: 0 });
  // bookImport.ts refParts("front:intro") returns [0, 0] (numbers).
  assert.equal(keptNoteHoldsRow(kept.get(intro), { chapter: 0, verse: 0, supportReference: YOU }), true);
});
