import assert from "node:assert";
import { draftFlowHash, draftOnFlowScreen, formatDraftMeta } from "./draftLocation.ts";

// Where an unsaved draft lives on the flows screens (issue #372): the hash a
// "Go to it" button opens, and whether the current screen already shows the
// draft's editor (then the reminder toast stays quiet).

const verse = { kind: "verse", book: "ZEC", chapter: 6, verse: 1, bibleVersion: "ULT" };
const tn = { kind: "row", rowKind: "tn", id: "f66i", book: "ZEC", chapter: 6, verse: 11 };
const tq = { kind: "row", rowKind: "tq", id: "q1 2", book: "ZEC", chapter: 6, verse: 2 };
const twl = { kind: "row", rowKind: "twl", id: "w9", book: "ZEC", chapter: 6, verse: 3 };
// tW/tA articles and note templates carry no book/chapter/verse.
const article = { kind: "article", resource: "ta", articleId: "figs-metaphor", path: "x", part: "body" };
const articleTitle = { ...article, part: "title" };
const template = { kind: "template", templateId: "t/1", supportRef: "rc://*/ta/man/translate/figs-idiom" };

// ── draftFlowHash ──────────────────────────────────────────────────────────
assert.strictEqual(draftFlowHash(verse), "#/scripture/ZEC/6/1");
assert.strictEqual(draftFlowHash(tn), "#/notes/ZEC/6/11?row=f66i");
assert.strictEqual(draftFlowHash(tq), "#/questions/ZEC/6/2?row=q1%202");
// The flows UI has no word-links editor; twl drafts open the classic editor.
assert.strictEqual(draftFlowHash(twl), "#/ZEC/6/3?twl=w9");
assert.strictEqual(draftFlowHash(article), "#/articles/ta/figs-metaphor");
// Templates are edited on the flows Curate screen.
assert.strictEqual(draftFlowHash(template), "#/admin/curate/t%2F1");

// ── draftOnFlowScreen ──────────────────────────────────────────────────────
// Same screen and chapter as the draft's editor: on screen.
assert.strictEqual(draftOnFlowScreen(verse, { view: "translateScripture", book: "ZEC", chapter: 6 }), true);
assert.strictEqual(draftOnFlowScreen(tn, { view: "notes", book: "ZEC", chapter: 6 }), true);
assert.strictEqual(draftOnFlowScreen(tq, { view: "questions", book: "ZEC", chapter: 6 }), true);
// Another chapter, book, or screen: off screen.
assert.strictEqual(draftOnFlowScreen(verse, { view: "translateScripture", book: "ZEC", chapter: 7 }), false);
assert.strictEqual(draftOnFlowScreen(tn, { view: "notes", book: "RUT", chapter: 6 }), false);
assert.strictEqual(draftOnFlowScreen(tn, { view: "questions", book: "ZEC", chapter: 6 }), false);
assert.strictEqual(draftOnFlowScreen(tq, { view: "notes", book: "ZEC", chapter: 6 }), false);
assert.strictEqual(draftOnFlowScreen(verse, { view: "verse", book: "ZEC", chapter: 6 }), false);
assert.strictEqual(draftOnFlowScreen(tn, { view: "books" }), false);
// No flows screen edits word links.
assert.strictEqual(draftOnFlowScreen(twl, { view: "notes", book: "ZEC", chapter: 6 }), false);
// tW and tA articles are edited on the Translate Words screen, whatever its
// book (articles are book-agnostic); templates on the Curate screen.
assert.strictEqual(draftOnFlowScreen(article, { view: "translateWords", book: "ZEC" }), true);
assert.strictEqual(draftOnFlowScreen(article, { view: "translateWords", book: "RUT" }), true);
assert.strictEqual(
  draftOnFlowScreen({ ...article, resource: "tw", articleId: "kt/god" }, { view: "translateWords", book: "ZEC" }),
  true,
);
assert.strictEqual(draftOnFlowScreen(article, { view: "books" }), false);
assert.strictEqual(draftOnFlowScreen(article, { view: "curate" }), false);
assert.strictEqual(draftOnFlowScreen(template, { view: "curate" }), true);
assert.strictEqual(draftOnFlowScreen(template, { view: "translateWords", book: "ZEC" }), false);
assert.strictEqual(draftOnFlowScreen(template, { view: "books" }), false);

// ── formatDraftMeta ────────────────────────────────────────────────────────
assert.strictEqual(formatDraftMeta(verse), "ULT ZEC 6:1");
assert.strictEqual(formatDraftMeta(tn), "TN ZEC 6:11");
assert.strictEqual(formatDraftMeta(article), "TA figs-metaphor");
assert.strictEqual(formatDraftMeta(articleTitle), "TA figs-metaphor · title");
assert.strictEqual(formatDraftMeta(template), "rc://*/ta/man/translate/figs-idiom · t/1");

console.log("draftLocation: all assertions passed.");
