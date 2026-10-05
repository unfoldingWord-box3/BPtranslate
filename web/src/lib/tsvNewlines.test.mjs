// Regression coverage for the translator screens' newline boundary
// (web/src/lib/tsvNewlines.ts) and its interaction with the outbox's 409
// auto-heal (web/src/sync/rowConflict.ts).
//
// The bug: TranslateNotesScreen / TranslateQuestionsScreen unescaped stored
// "\n" sequences into real newlines for editing, then PATCHed — and recorded
// the conflict baseline — in that real-newline form. A multi-line note on the
// server keeps the escaped form, so on any 409 classifyRowPatchConflict
// compared escaped server text with a real-newline baseline, never matched,
// and surfaced "another editor changed this note" for a healable bump.

import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeNewlines, unescapeNewlines } from "./tsvNewlines.ts";
import { classifyRowPatchConflict } from "../sync/rowConflict.ts";

const STORED = "First paragraph.\\n\\nSecond paragraph.";

test("escape is the inverse of unescape for stored text", () => {
  assert.equal(escapeNewlines(unescapeNewlines(STORED)), STORED);
});

test("escape folds CRLF and lone CR to the stored form", () => {
  assert.equal(escapeNewlines("a\r\nb\rc\nd"), "a\\nb\\nc\\nd");
});

test("escape leaves single-line text untouched", () => {
  assert.equal(escapeNewlines("one line"), "one line");
});

test("multi-line note: a version bump that left the note alone auto-heals", () => {
  // Editor state as the screens hold it (real newlines).
  const baselineInEditor = unescapeNewlines(STORED);
  const draftInEditor = "First paragraph, edited.\n\nSecond paragraph.";
  // Server row after an unrelated bump: same note text, escaped as stored.
  const server = { note: STORED, version: 3 };
  assert.equal(
    classifyRowPatchConflict(
      { note: escapeNewlines(draftInEditor) },
      { note: escapeNewlines(baselineInEditor) },
      server,
    ),
    "auto_heal",
  );
  // The pre-fix shape (real newlines on the wire) is what produced the prompt.
  assert.equal(
    classifyRowPatchConflict({ note: draftInEditor }, { note: baselineInEditor }, server),
    "conflict",
  );
});

test("multi-line note: a genuine server change to the note still conflicts", () => {
  const baselineInEditor = unescapeNewlines(STORED);
  const server = { note: "Someone else rewrote it.\\nEntirely.", version: 3 };
  assert.equal(
    classifyRowPatchConflict(
      { note: escapeNewlines("Mine.\nAlso mine.") },
      { note: escapeNewlines(baselineInEditor) },
      server,
    ),
    "conflict",
  );
});
