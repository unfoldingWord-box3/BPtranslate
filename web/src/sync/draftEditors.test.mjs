import assert from "node:assert/strict";
import {
  draftEditorsVersion,
  isDraftEditorShown,
  showDraftEditors,
  subscribeDraftEditors,
} from "./draftEditors.ts";

// Which drafts have their editor on screen right now (#372). The flows
// unsaved-drafts toast stays quiet only for these, so a draft whose editor was
// paged away from (next verse, next note, another article or template) on the
// same screen and chapter still gets its reminder.

const v11 = "verse:ZEC:1:1:ULT";
const v12 = "verse:ZEC:1:2:ULT";
const tnA = "row:tn:ZEC:aaaa";

let calls = 0;
const unsub = subscribeDraftEditors(() => calls++);

assert.equal(isDraftEditorShown(v11), false, "nothing shown at start");

// Scripture screen on 1:1 shows the 1:1 editor.
const release11 = showDraftEditors([v11]);
assert.equal(isDraftEditorShown(v11), true, "1:1 editor showing");
assert.equal(isDraftEditorShown(v12), false, "same chapter, other verse is not showing");

// Next → 1:2: the 1:1 editor goes away, so its draft is off screen.
release11();
const release12 = showDraftEditors([v12]);
assert.equal(isDraftEditorShown(v11), false, "after Next, the 1:1 draft is off screen");
assert.equal(isDraftEditorShown(v12), true, "after Next, the 1:2 editor is showing");

// Notes / questions: only the selected card's draft is on screen; another card
// in the same chapter (e.g. after Next) is not.
const releaseTn = showDraftEditors(["row:tn:ZEC:aaaa"]);
assert.equal(isDraftEditorShown("row:tn:ZEC:bbbb"), false, "same chapter, other note is not showing");
assert.equal(isDraftEditorShown("row:tq:ZEC:aaaa"), false, "a question with the same id is not the note");
releaseTn();
// Translate Words: the open article's parts are on screen; another article is not.
const releaseArt = showDraftEditors(["article:ta:translate/figs-idiom/title.md", "article:ta:translate/figs-idiom/01.md"]);
assert.equal(isDraftEditorShown("article:ta:translate/figs-idiom/01.md"), true, "open article's body part showing");
assert.equal(isDraftEditorShown("article:tw:bible/kt/god.md"), false, "another article is not showing");
releaseArt();
// Curate: the open template is on screen; another template is not.
const releaseT1 = showDraftEditors(["template:t1"]);
assert.equal(isDraftEditorShown("template:t2"), false, "another template is not showing");
releaseT1();
assert.equal(isDraftEditorShown("template:t1"), false, "closing the template editor takes it off screen");

// Two editors on the same key (e.g. a StrictMode double mount) count once each.
const releaseA1 = showDraftEditors([tnA]);
const releaseA2 = showDraftEditors([tnA]);
releaseA1();
assert.equal(isDraftEditorShown(tnA), true, "still shown while one holder remains");
releaseA2();
assert.equal(isDraftEditorShown(tnA), false, "gone once every holder released");

// Releasing twice is harmless.
releaseA2();
assert.equal(isDraftEditorShown(tnA), false, "double release does not go negative");
const releaseA3 = showDraftEditors([tnA]);
assert.equal(isDraftEditorShown(tnA), true, "a later show still registers after a double release");
releaseA3();

// Subscribers hear every change, and the version moves with them.
const before = draftEditorsVersion();
const r = showDraftEditors(["template:t1"]);
assert.ok(draftEditorsVersion() > before, "version moves on show");
r();
assert.ok(calls > 0, "subscriber was called");
const n = calls;
showDraftEditors([])();
assert.equal(calls, n, "an empty show does not notify");

release12();
unsub();
console.log("draftEditors: all assertions passed.");
