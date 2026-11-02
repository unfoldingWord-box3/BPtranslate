import assert from "node:assert";
import { versionDirection, versionLabel } from "./versionLabels.ts";

// Minimal config stand-ins — only the label fields matter here.
const en = {
  litLabel: "ULT",
  simLabel: "UST",
  origHebrewLabel: "UHB",
  origGreekLabel: "UGNT",
};
const gl = {
  litLabel: "GLT",
  simLabel: "GST",
  origHebrewLabel: "UHB",
  origGreekLabel: "UGNT",
};
const arabic = {
  litLabel: "GLT",
  simLabel: "GST",
  origHebrewLabel: "التوراة العبرية",
  origGreekLabel: "UGNT",
};

let pass = 0;
function check(name, got, want) {
  assert.strictEqual(got, want, `${name}: expected "${want}", got "${got}"`);
  pass++;
  console.log(`  ok: ${name}`);
}

// Role codes map to the project's display labels.
check("en ULT → ULT", versionLabel(en, "ULT"), "ULT");
check("en UST → UST", versionLabel(en, "UST"), "UST");
check("gl ULT → GLT", versionLabel(gl, "ULT"), "GLT");
check("gl UST → GST", versionLabel(gl, "UST"), "GST");
check("gl UHB → UHB", versionLabel(gl, "UHB"), "UHB");
check("gl UGNT → UGNT", versionLabel(gl, "UGNT"), "UGNT");

// Originals can carry a native label per project.
check("arabic UHB → native", versionLabel(arabic, "UHB"), "التوراة العبرية");

// Unknown role codes pass through unchanged.
check("unknown code passthrough", versionLabel(gl, "NAV"), "NAV");

// Null config (first paint / offline) falls back to the role code.
check("null cfg → role code", versionLabel(null, "ULT"), "ULT");

// Older-schema config missing the originals labels falls back to the role code.
check(
  "missing origHebrewLabel → role code",
  versionLabel({ litLabel: "GLT", simLabel: "GST" }, "UHB"),
  "UHB",
);

// Direction is tri-state (issue #451): a target lane's direction is unknown
// until the project config arrives, so the verse screen can wait instead of
// guessing LTR. The originals are fixed by their script and never wait.
check("null cfg ULT → unknown", versionDirection(null, "ULT"), null);
check("null cfg UST → unknown", versionDirection(null, "UST"), null);
check("null cfg UHB → rtl", versionDirection(null, "UHB"), "rtl");
check("null cfg UGNT → ltr", versionDirection(null, "UGNT"), "ltr");
check("rtl cfg ULT → rtl", versionDirection({ direction: "rtl" }, "ULT"), "rtl");
check("rtl cfg UST → rtl", versionDirection({ direction: "rtl" }, "UST"), "rtl");
check("ltr cfg ULT → ltr", versionDirection({ direction: "ltr" }, "ULT"), "ltr");
check("rtl cfg UGNT → ltr", versionDirection({ direction: "rtl" }, "UGNT"), "ltr");
check("ltr cfg UHB → rtl", versionDirection({ direction: "ltr" }, "UHB"), "rtl");

console.log(`\nversionLabels: all ${pass} assertions passed.`);
