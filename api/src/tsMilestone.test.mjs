// isTsMilestone must match every node shape usfm-js has produced for `\ts\*`
// and nothing else. Run from api/:
//   node --experimental-strip-types --no-warnings src/tsMilestone.test.mjs

import { isTsMilestone } from "./tsMilestone.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

assert(isTsMilestone({ tag: "ts\\*", nextChar: "\n" }), "usfm-js 3.5.0 shape {tag:'ts\\\\*'}");
assert(isTsMilestone({ tag: "ts*" }), "editor-written shape {tag:'ts*'}");
assert(isTsMilestone({ tag: "ts", content: "\\*" }), "legacy shape {tag:'ts', content:'\\\\*'}");
assert(isTsMilestone({ tag: "ts", content: "*" }), "legacy shape {tag:'ts', content:'*'}");
assert(!isTsMilestone({ tag: "ts" }), "a bare ts tag with no closing star is not a milestone");
assert(!isTsMilestone({ tag: "ts", content: "x" }), "ts with other content is not a milestone");
assert(!isTsMilestone({ tag: "q1", type: "quote" }), "a poetry marker is not a milestone");
assert(!isTsMilestone({ type: "text", text: "\\ts\\*" }), "text that spells the marker is not a milestone");
assert(!isTsMilestone(null) && !isTsMilestone(undefined), "null and undefined are not milestones");
console.log("all tsMilestone tests passed");
