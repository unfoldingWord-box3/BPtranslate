import assert from "node:assert";
import { draftFlowHash, formatDraftMeta } from "./draftLocation.ts";

// Where an unsaved draft lives on the flows screens (issue #372): the hash a
// "Go to it" button opens, and the draft's label. Whether its editor is
// showing is sync/draftEditors.ts (tested there).

const verse = { kind: "verse", book: "ZEC", chapter: 6, verse: 1, bibleVersion: "ULT" };
const tn = { kind: "row", rowKind: "tn", id: "f66i", book: "ZEC", chapter: 6, verse: 11 };
const tq = { kind: "row", rowKind: "tq", id: "q1 2", book: "ZEC", chapter: 6, verse: 2 };
const twl = { kind: "row", rowKind: "twl", id: "w9", book: "ZEC", chapter: 6, verse: 3 };
// tW/tA articles and note templates carry no book/chapter/verse.
const article = { kind: "article", resource: "ta", articleId: "figs-metaphor", path: "x", part: "body" };
const articleTitle = { ...article, part: "title" };
const template = { kind: "template", templateId: "t/1", supportRef: "rc://*/ta/man/translate/figs-idiom" };
// Translation preferences (#909) have no reference either.
const prefs = { kind: "prefs", section: "common_issues_md" };

// ── draftFlowHash ──────────────────────────────────────────────────────────
assert.strictEqual(draftFlowHash(verse), "#/scripture/ZEC/6/1");
assert.strictEqual(draftFlowHash(tn), "#/notes/ZEC/6/11?row=f66i");
assert.strictEqual(draftFlowHash(tq), "#/questions/ZEC/6/2?row=q1%202");
// The flows UI has no word-links editor; twl drafts open the classic editor.
assert.strictEqual(draftFlowHash(twl), "#/ZEC/6/3?twl=w9");
assert.strictEqual(draftFlowHash(article), "#/articles/ta/figs-metaphor");
// Templates are edited on the flows Curate screen.
assert.strictEqual(draftFlowHash(template), "#/admin/curate/t%2F1");
// Brief / Instructions / Common issues are edited on the desk Style page.
assert.strictEqual(draftFlowHash(prefs), "#/admin/style");

// ── formatDraftMeta ────────────────────────────────────────────────────────
assert.strictEqual(formatDraftMeta(verse), "ULT ZEC 6:1");
assert.strictEqual(formatDraftMeta(tn), "TN ZEC 6:11");
assert.strictEqual(formatDraftMeta(article), "TA figs-metaphor");
assert.strictEqual(formatDraftMeta(articleTitle), "TA figs-metaphor · title");
assert.strictEqual(formatDraftMeta(template), "rc://*/ta/man/translate/figs-idiom · t/1");
assert.strictEqual(formatDraftMeta(prefs), "Style · Common issues");
assert.strictEqual(formatDraftMeta({ kind: "prefs", section: "brief" }), "Style · Brief");
// #913 item 7: with the UI's translator, the page and box names are translated.
const ar = {
  "moreTools.style.title": "الأسلوب",
  "moreTools.style.sectionBrief": "الموجز",
  "moreTools.style.sectionCommonIssues": "المشكلات الشائعة",
};
const tAr = (k) => ar[k] ?? k;
assert.strictEqual(formatDraftMeta({ kind: "prefs", section: "brief" }, tAr), "الأسلوب · الموجز");
assert.strictEqual(formatDraftMeta(prefs, tAr), "الأسلوب · المشكلات الشائعة");
// Other kinds name a reference, not a page, and are unchanged.
assert.strictEqual(formatDraftMeta(verse, tAr), "ULT ZEC 6:1");

console.log("draftLocation: all assertions passed.");
