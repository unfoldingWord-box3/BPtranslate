// Tests for aiRunPlacement.ts — where a flow screen puts its "start an AI
// run" trigger (#481, decision A). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/aiRunPlacement.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { aiRunPlacement, canRunAi } from "./aiRunPlacement.ts";

test("canRunAi matches the server's requireEditor (admin or editor only)", () => {
  assert.equal(canRunAi("admin"), true);
  assert.equal(canRunAi("editor"), true);
  assert.equal(canRunAi("viewer"), false);
});

test("viewers get no trigger at any band", () => {
  for (const band of ["phone", "tablet", "desktop"]) {
    assert.equal(aiRunPlacement("viewer", band), "hidden", band);
  }
});

test("editors and admins: top bar on tablet and desktop, overflow menu on phone", () => {
  for (const role of ["admin", "editor"]) {
    assert.equal(aiRunPlacement(role, "desktop"), "topbar", `${role} desktop`);
    assert.equal(aiRunPlacement(role, "tablet"), "topbar", `${role} tablet`);
    assert.equal(aiRunPlacement(role, "phone"), "overflow", `${role} phone`);
  }
});
