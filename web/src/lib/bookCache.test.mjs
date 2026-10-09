import test from "node:test";
import assert from "node:assert/strict";
import { applyCacheOp, broadcastUpsertAction, ChapterFetchTracker } from "./bookCache.ts";

const row = (id, extra = {}) => ({ id, chapter: 0, verse: 0, version: 1, note: id, ...extra });
const payload = (tn) => ({ book: "ZEC", chapter: 0, verses: {}, tn, tq: [], twl: [], verseStatuses: [], verseLaneChecks: [] });
const ids = (p) => p.tn.map((r) => r.id);

// Item 2 (#562): insert / delete reach the book cache.
test("insert after a row lands right after it", () => {
  const p = applyCacheOp(payload([row("a"), row("b")]), { t: "insert", kind: "tn", row: row("n"), afterId: "a" });
  assert.deepEqual(ids(p), ["a", "n", "b"]);
});

test("insert without an anchor (or a missing one) appends; a duplicate id is a no-op", () => {
  const base = payload([row("a")]);
  assert.deepEqual(ids(applyCacheOp(base, { t: "insert", kind: "tn", row: row("n") })), ["a", "n"]);
  assert.deepEqual(ids(applyCacheOp(base, { t: "insert", kind: "tn", row: row("n"), afterId: "zz" })), ["a", "n"]);
  assert.equal(applyCacheOp(base, { t: "insert", kind: "tn", row: row("a") }), base);
});

test("delete removes the row; an unknown id leaves the payload untouched", () => {
  const base = payload([row("a"), row("b")]);
  assert.deepEqual(ids(applyCacheOp(base, { t: "delete", kind: "tn", id: "a" })), ["b"]);
  assert.equal(applyCacheOp(base, { t: "delete", kind: "tn", id: "zz" }), base);
});

test("patch merges fields; an unknown id leaves the payload untouched", () => {
  const base = payload([row("a")]);
  assert.equal(applyCacheOp(base, { t: "patch", kind: "tn", id: "a", patch: { note: "x" } }).tn[0].note, "x");
  assert.equal(applyCacheOp(base, { t: "patch", kind: "tn", id: "zz", patch: { note: "x" } }), base);
});

// Item 4 (#562): a load of an already-ready chapter does not refetch, and a
// fetch that lands after a local edit keeps that edit.
test("beginLoad refuses a chapter that is ready or already loading", () => {
  const tr = new ChapterFetchTracker();
  const tok = tr.beginLoad(0);
  assert.notEqual(tok, null);
  assert.equal(tr.beginLoad(0), null, "second load while in flight");
  assert.ok(tr.land(0, tok, payload([row("a")])));
  assert.equal(tr.beginLoad(0), null, "load after ready must not refetch");
});

test("a failed load can be retried; reset forgets ready chapters", () => {
  const tr = new ChapterFetchTracker();
  const tok = tr.beginLoad(3);
  tr.fail(3, tok);
  const again = tr.beginLoad(3);
  assert.notEqual(again, null);
  tr.land(3, again, payload([]));
  tr.reset();
  assert.notEqual(tr.beginLoad(3), null);
});

test("a superseded fetch is not adopted", () => {
  const tr = new ChapterFetchTracker();
  const first = tr.beginLoad(0);
  const second = tr.beginReload(0);
  assert.equal(tr.land(0, first, payload([row("old")])), null);
  assert.deepEqual(ids(tr.land(0, second, payload([row("new")]))), ["new"]);
});

test("a reload landing after an optimistic patch / insert / delete keeps them", () => {
  const tr = new ChapterFetchTracker();
  const load = tr.beginLoad(0);
  tr.land(0, load, payload([row("a"), row("b")]));
  const tok = tr.beginReload(0);
  // Local edits made while the reload is in flight.
  tr.record(0, { t: "patch", kind: "tn", id: "a", patch: { trashed_at: 99 } });
  tr.record(0, { t: "insert", kind: "tn", row: row("n"), afterId: "a" });
  tr.record(0, { t: "delete", kind: "tn", id: "b" });
  // Edits to another chapter are not replayed here.
  tr.record(5, { t: "delete", kind: "tn", id: "a" });
  // The server answer predates those edits but carries a newer field on "a".
  const fetched = payload([row("a", { note: "server" }), row("b")]);
  const merged = tr.land(0, tok, fetched);
  assert.deepEqual(ids(merged), ["a", "n"]);
  assert.equal(merged.tn[0].trashed_at, 99, "optimistic patch survives");
  assert.equal(merged.tn[0].note, "server", "server fields not touched locally are adopted");
});

test("a replace op does not roll a newer fetched row back", () => {
  const tr = new ChapterFetchTracker();
  const tok = tr.beginLoad(0);
  tr.record(0, { t: "replace", kind: "tn", row: row("a", { version: 2, note: "mine" }) });
  const merged = tr.land(0, tok, payload([row("a", { version: 3, note: "newer" })]));
  assert.equal(merged.tn[0].note, "newer");
  const tok2 = tr.beginReload(0);
  tr.record(0, { t: "replace", kind: "tn", row: row("a", { version: 4, note: "mine" }) });
  assert.equal(tr.land(0, tok2, payload([row("a", { version: 3 })])).tn[0].note, "mine");
});

// Review A2: a reload that supersedes an in-flight fetch keeps the edits
// recorded against it.
test("a superseding reload carries over ops recorded against the earlier fetch", () => {
  const tr = new ChapterFetchTracker();
  const first = tr.beginLoad(0);
  tr.record(0, { t: "patch", kind: "tn", id: "a", patch: { trashed_at: 5 } });
  const second = tr.beginReload(0);
  tr.record(0, { t: "delete", kind: "tn", id: "b" });
  assert.equal(tr.land(0, first, payload([row("a")])), null);
  const merged = tr.land(0, second, payload([row("a"), row("b")]));
  assert.deepEqual(ids(merged), ["a"]);
  assert.equal(merged.tn[0].trashed_at, 5);
});

// Review A3: a broadcast recorded as an insert while the chapter was loading
// still wins over an older fetched copy of the same row.
test("insert of a row already present applies as a version-guarded replace", () => {
  const base = payload([row("a", { version: 1, note: "old" })]);
  assert.equal(applyCacheOp(base, { t: "insert", kind: "tn", row: row("a", { version: 2, note: "new" }) }).tn[0].note, "new");
  assert.equal(applyCacheOp(base, { t: "insert", kind: "tn", row: row("a", { version: 1, note: "same" }) }), base);
  const newer = payload([row("a", { version: 3, note: "server" })]);
  assert.equal(applyCacheOp(newer, { t: "insert", kind: "tn", row: row("a", { version: 2 }) }), newer);
  const tr = new ChapterFetchTracker();
  const tok = tr.beginLoad(0);
  tr.record(0, { t: "insert", kind: "tn", row: row("a", { version: 2, note: "broadcast" }) });
  assert.equal(tr.land(0, tok, base).tn[0].note, "broadcast");
});

// Review A4: joining the intro room after missing its events resyncs chapter 0.
test("introRoomJoined: true only on the null -> room transition", async () => {
  const { introRoomJoined } = await import("./bookIntro.ts");
  assert.equal(introRoomJoined(null, 0), true);
  assert.equal(introRoomJoined(0, 0), false);
  assert.equal(introRoomJoined(0, null), false);
  assert.equal(introRoomJoined(null, null), false);
});

// Item 1 (#562): a broadcast row from the chapter-0 room is applied with the
// same rules as the open chapter's room.
test("broadcastUpsertAction: insert when missing, replace when newer, skip when older", () => {
  assert.equal(broadcastUpsertAction("tn", undefined, row("a")), "insert");
  assert.equal(broadcastUpsertAction("tn", row("a", { version: 1 }), row("a", { version: 2 })), "replace");
  assert.equal(broadcastUpsertAction("tn", row("a", { version: 2 }), row("a", { version: 1 })), "skip");
  assert.equal(broadcastUpsertAction("tn", row("a"), row("a")), "skip");
});

test("broadcastUpsertAction: same-version tn state flips (preserve / hint / trash) replace", () => {
  assert.equal(broadcastUpsertAction("tn", row("a", { preserve: 0 }), row("a", { preserve: 1 })), "replace");
  assert.equal(broadcastUpsertAction("tn", row("a", { hint: 0 }), row("a", { hint: 1 })), "replace");
  assert.equal(broadcastUpsertAction("tn", row("a", { trashed_at: null }), row("a", { trashed_at: 7 })), "replace");
  assert.equal(broadcastUpsertAction("tq", row("a", { trashed_at: null }), row("a", { trashed_at: 7 })), "skip");
});
