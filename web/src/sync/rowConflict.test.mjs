// Tests for classifyRowPatchConflict (web/src/sync/rowConflict.ts) — the pure
// decision behind auto-healing spurious row 409s vs prompting on genuine ones.
// Regression coverage for the "TQ conflict on almost every edit, resolves by
// just clicking" report: a version bump from an unrelated concurrent change (or
// our own edit already landing) must NOT surface a conflict prompt, while a real
// same-field conflict still must.

import assert from "node:assert/strict";
import { classifyRowPatchConflict } from "./rowConflict.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

// (a) Idempotent — the server already has exactly what we're setting (our edit
// already landed / an echo). Safe even with no baseline.
check(
  classifyRowPatchConflict(
    { question: "Who is Zechariah?" },
    undefined,
    { version: 3, question: "Who is Zechariah?", response: "A prophet." },
  ) === "auto_heal",
  "idempotent patch (server already has our value) auto-heals without a baseline",
);

// (b) Unrelated field changed — the version advanced because the server's
// RESPONSE changed, but our patch only touches QUESTION and the server's
// question still equals our baseline. Applying our edit clobbers nothing.
check(
  classifyRowPatchConflict(
    { question: "Who was Zechariah?" },
    { question: "Who is Zechariah?" },
    { version: 4, question: "Who is Zechariah?", response: "EDITED ELSEWHERE" },
  ) === "auto_heal",
  "unrelated field changed on server, our field untouched vs baseline -> auto-heal",
);

// Genuine conflict — the server changed the SAME field we're editing, to a
// different value than both our target and our baseline. Must prompt.
check(
  classifyRowPatchConflict(
    { question: "MY VERSION" },
    { question: "original" },
    { version: 4, question: "THEIR VERSION", response: "x" },
  ) === "conflict",
  "server changed the same field to a different value -> conflict",
);

// No baseline + server value differs from ours -> conservative conflict (we
// can't prove the server didn't intentionally set that value).
check(
  classifyRowPatchConflict(
    { question: "MY VERSION" },
    undefined,
    { version: 4, question: "SOMETHING ELSE" },
  ) === "conflict",
  "no baseline and server differs -> conflict (conservative)",
);

// Multi-field: one field is idempotent, the other untouched vs baseline -> heal.
check(
  classifyRowPatchConflict(
    { question: "new Q", response: "same R" },
    { question: "old Q", response: "same R" },
    { version: 5, question: "old Q", response: "same R" },
  ) === "auto_heal",
  "multi-field: idempotent + untouched -> auto-heal",
);

// Multi-field: any single genuinely-conflicting field forces a conflict.
check(
  classifyRowPatchConflict(
    { question: "new Q", response: "new R" },
    { question: "old Q", response: "old R" },
    { version: 5, question: "old Q", response: "THEIR R" },
  ) === "conflict",
  "multi-field: one conflicting field -> conflict",
);

// null (server) vs undefined (our unset optimistic field) are the same absent
// value — occurrence heal / empty column shouldn't read as a conflict.
check(
  classifyRowPatchConflict(
    { occurrence: undefined, question: "q" },
    { occurrence: null, question: "q0" },
    { version: 2, occurrence: null, question: "q0" },
  ) === "auto_heal",
  "null server value equals undefined patch value -> auto-heal",
);

// Both tabs set the SAME new value for the same field — idempotent branch wins
// over the differing baseline; no data is lost, so no prompt.
check(
  classifyRowPatchConflict(
    { question: "agreed value" },
    { question: "old A" },
    { version: 6, question: "agreed value" },
  ) === "auto_heal",
  "both writers converged on the same value -> auto-heal (idempotent)",
);

// Missing / non-object server row (409 body carried no `current`) — can't prove
// safety, so leave it to the user.
check(
  classifyRowPatchConflict({ question: "q" }, { question: "q0" }, null) === "conflict",
  "missing server row -> conflict",
);

// occurrence as a real second-occurrence change that the server also moved
// differently is a genuine numeric conflict.
check(
  classifyRowPatchConflict(
    { occurrence: 2 },
    { occurrence: 1 },
    { version: 3, occurrence: 3 },
  ) === "conflict",
  "numeric field changed on both sides to different values -> conflict",
);

// Newline forms (#664). D1 holds tn/tq text with a literal backslash-n (TSV
// imports, NoteCard) or a real newline (rows the flows Translate screens saved
// before #593). The same text in either form is the same value.
check(
  classifyRowPatchConflict(
    { note: "a\\nb2" },
    { note: "a\\nb" },
    { version: 3, note: "a\nb" },
  ) === "auto_heal",
  "escaped baseline vs a real-newline server note with the same text -> auto_heal",
);

check(
  classifyRowPatchConflict(
    { note: "a\nb2" },
    { note: "a\nb" },
    { version: 3, note: "a\\nb" },
  ) === "auto_heal",
  "real-newline baseline vs an escaped server note with the same text -> auto_heal",
);

check(
  classifyRowPatchConflict(
    { note: "a\\nb2" },
    { note: "a\\nb" },
    { version: 3, note: "someone else\nrewrote it" },
  ) === "conflict",
  "a multi-line note genuinely changed on the server still -> conflict",
);

console.log(`\nrowConflict.test.mjs: ${passed} checks passed`);
