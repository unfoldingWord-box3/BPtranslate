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
import { openDraftsChangedChannel } from "./draftsChangedChannel.ts";

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
