// Tests for the cross-tab "drafts changed" message (issue #896,
// draftsChangedChannel.ts).
//
// The defect: the drafts store is one IndexedDB database shared by every tab
// of a workspace, but a tab's "N unsaved" chip re-counted only after a change
// made in that same tab. When tab A saved or discarded a draft, tab B kept the
// old count until a reload. drafts.ts now announces each committed change on a
// per-workspace BroadcastChannel and every other tab re-reads the store.
// Node's BroadcastChannel stands in for the browser's; each tab opens one.

import test from "node:test";
import assert from "node:assert/strict";
import { openDraftsChangedChannel, orderedReads } from "./draftsChangedChannel.ts";

const CHANNEL = "be-drafts-changed-test";

function twoTabs(name = CHANNEL) {
  const heard = { a: 0, b: 0 };
  const a = openDraftsChangedChannel(name, () => heard.a++);
  const b = openDraftsChangedChannel(name, () => heard.b++);
  return { a, b, heard, close: () => (a.close(), b.close()) };
}

// Delivery is async; wait for it rather than for a fixed time (the suite runs
// files in parallel, so a short sleep can lose the race).
async function until(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting for a cross-tab message");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("cross-tab drafts: a change announced in tab A makes tab B re-read; tab A hears no echo", async () => {
  const tabs = twoTabs();
  try {
    tabs.a.announce();
    await until(() => tabs.heard.b > 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(tabs.heard.b, 1);
    assert.equal(tabs.heard.a, 0, "the announcing tab already told its own subscribers");
  } finally {
    tabs.close();
  }
});

test("cross-tab drafts: another workspace's channel does not hear the change", async () => {
  const tabs = twoTabs();
  let other = 0;
  const orgB = openDraftsChangedChannel(`${CHANNEL}-orgb`, () => other++);
  try {
    tabs.a.announce();
    await until(() => tabs.heard.b > 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(other, 0);
  } finally {
    orgB.close();
    tabs.close();
  }
});

test("cross-tab drafts: malformed messages are ignored", async () => {
  const tabs = twoTabs();
  const raw = new BroadcastChannel(CHANNEL);
  try {
    raw.postMessage("drafts-changed");
    raw.postMessage(null);
    raw.postMessage(["drafts-changed"]);
    raw.postMessage({ type: "something-else" });
    raw.postMessage({});
    // One valid message last from the same sender: once it arrives, every
    // earlier one has too (a channel delivers one sender's posts in order).
    raw.postMessage({ type: "drafts-changed" });
    await until(() => tabs.heard.b > 0);
    assert.equal(tabs.heard.b, 1);
    assert.equal(tabs.heard.a, 1);
  } finally {
    raw.close();
    tabs.close();
  }
});

test("cross-tab drafts: hearing a change does not post one, so two tabs cannot ping-pong", async () => {
  // drafts.ts re-reads on a received message without announcing; model that
  // here and count every message on the channel.
  let posted = 0;
  const raw = new BroadcastChannel(CHANNEL);
  raw.onmessage = () => posted++;
  const a = openDraftsChangedChannel(CHANNEL, () => undefined);
  const b = openDraftsChangedChannel(CHANNEL, () => undefined);
  try {
    a.announce();
    await until(() => posted > 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(posted, 1);
  } finally {
    raw.close();
    a.close();
    b.close();
  }
});

test("cross-tab drafts: no BroadcastChannel, or one that throws, is a silent no-op", () => {
  const none = openDraftsChangedChannel(CHANNEL, () => assert.fail("never called"), () => null);
  none.announce();
  none.close();
  const throws = openDraftsChangedChannel(CHANNEL, () => undefined, () => {
    throw new Error("blocked");
  });
  throws.announce();
  throws.close();
  const failsToPost = openDraftsChangedChannel(CHANNEL, () => undefined, () => ({
    onmessage: null,
    postMessage() {
      throw new Error("closed");
    },
    close() {},
  }));
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    failsToPost.announce();
  } finally {
    console.warn = warn;
    failsToPost.close();
  }
});

// Review (Codex): drafts.ts reads the store for a local change (to every
// subscriber) and for another tab's message (to the count only). Reads can
// resolve out of order, and the count hears both, so an older read landing
// after a newer one would put back an older list. orderedReads numbers every
// read when it starts and gives each subscriber only results newer than the
// last one it got.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function harness() {
  const errors = [];
  const readFor = orderedReads((e) => errors.push(e.message));
  const pending = [];
  const read = () => {
    const d = deferred();
    pending.push(d);
    return d.promise;
  };
  const sub = () => {
    const got = [];
    const fn = (v) => got.push(v);
    fn.got = got;
    return fn;
  };
  return { readFor, read, pending, sub, errors };
}

test("cross-tab drafts: an older local read landing after a newer remote one skips the count, reaches a local-only subscriber", async () => {
  const { readFor, read, pending, sub } = harness();
  const count = sub(); // hears local and remote reads
  const editor = sub(); // hears local reads only
  const local = readFor(read, [count, editor]); // read 1: a change in this tab
  const remote = readFor(read, [count]); // read 2: another tab's message
  pending[1].resolve("newer list");
  await remote;
  pending[0].resolve("older list");
  await local;
  assert.deepEqual(count.got, ["newer list"], "the count keeps the newer list");
  assert.deepEqual(editor.got, ["older list"], "nothing newer reached the editor, so it gets this one");
  // A later read reaches both, as usual.
  const later = readFor(read, [count, editor]);
  pending[2].resolve("latest");
  await later;
  assert.deepEqual(count.got, ["newer list", "latest"]);
  assert.deepEqual(editor.got, ["older list", "latest"]);
});

test("cross-tab drafts: overlapping reads that resolve in order are all delivered", async () => {
  const { readFor, read, pending, sub } = harness();
  const count = sub();
  const first = readFor(read, [count]);
  const second = readFor(read, [count]);
  pending[0].resolve("a");
  await first;
  pending[1].resolve("b");
  await second;
  assert.deepEqual(count.got, ["a", "b"]);
});

// A failed newer read delivers nothing and records nothing, so an older read
// that succeeds is still delivered (and the receive path's `void` call never
// sees a rejection: Claude F5).
test("cross-tab drafts: a failed newer read does not hold back an older one that succeeds", async () => {
  const { readFor, read, pending, sub, errors } = harness();
  const count = sub();
  const older = readFor(read, [count]);
  const newer = readFor(read, [count]);
  pending[1].reject(new Error("idb closed"));
  await newer;
  assert.deepEqual(errors, ["idb closed"]);
  assert.deepEqual(count.got, []);
  pending[0].resolve("older list");
  await older;
  assert.deepEqual(count.got, ["older list"]);
});
