import assert from "node:assert";
import { openPrefsDraftChannel, parsePrefsDraftMessage } from "./prefsDraftChannel.ts";

// Issue #913 review A1/A2: a prefs draft discarded or saved in one tab is told
// to the other tabs showing it, by key.

// ── parsePrefsDraftMessage ─────────────────────────────────────────────────
const discard = { type: "prefs-discard", key: "prefs:common_issues_md" };
const saved = { type: "prefs-saved", key: "prefs:brief", text: { audience: "a", notes: null }, version: 7 };
assert.deepStrictEqual(parsePrefsDraftMessage(discard), discard);
assert.deepStrictEqual(parsePrefsDraftMessage(saved), saved);
// Shape-checked: tabs on other builds share the channel.
assert.strictEqual(parsePrefsDraftMessage(null), null);
assert.strictEqual(parsePrefsDraftMessage({ type: "prefs-discard", key: "row:tn:ZEC:1" }), null);
assert.strictEqual(parsePrefsDraftMessage({ type: "prefs-discard" }), null);
assert.strictEqual(parsePrefsDraftMessage({ ...saved, version: "7" }), null);
assert.strictEqual(parsePrefsDraftMessage({ ...saved, text: { audience: 1 } }), null);
assert.strictEqual(parsePrefsDraftMessage({ ...saved, text: ["a"] }), null);
assert.strictEqual(parsePrefsDraftMessage({ type: "drafts-changed" }), null);

// ── openPrefsDraftChannel ──────────────────────────────────────────────────
// Two fake channels joined like BroadcastChannel: a post reaches the other one
// only, never its own.
function pair() {
  const a = { onmessage: null, posted: [], postMessage(m) { this.posted.push(m); b.onmessage?.({ data: m }); }, close() {} };
  const b = { onmessage: null, posted: [], postMessage(m) { this.posted.push(m); a.onmessage?.({ data: m }); }, close() {} };
  return [a, b];
}
const [ca, cb] = pair();
const heardA = [];
const heardB = [];
const tabA = openPrefsDraftChannel("x", (m) => heardA.push(m), () => ca);
openPrefsDraftChannel("x", (m) => heardB.push(m), () => cb);
tabA.announce(saved);
tabA.announce(discard);
assert.deepStrictEqual(heardB, [saved, discard]);
assert.deepStrictEqual(heardA, []);
// A bad message from the other side is ignored.
cb.postMessage({ type: "prefs-saved", key: "prefs:brief" });
assert.deepStrictEqual(heardA, []);
// No BroadcastChannel: announce is a no-op.
openPrefsDraftChannel("x", () => {}, () => null).announce(discard);
openPrefsDraftChannel("x", () => {}, () => {
  throw new Error("blocked");
}).announce(discard);

console.log("prefsDraftChannel: all assertions passed.");
