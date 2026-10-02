import { test } from "node:test";
import assert from "node:assert/strict";
import { searchHelp } from "./search.ts";

const art = (id, title, keywords, headings, body) => ({ id, title, routes: [], roles: ["editor"], keywords, headings, body });
const fixture = [
  art("books", "Choosing a book", ["book", "import"], ["Pick a book"], "Open the Books screen and pick a book to work on."),
  art(
    "save-and-sync",
    "Saving and sync",
    ["save", "unsaved", "offline"],
    ["Unsaved changes"],
    "Your edits are kept on this device. An **unsaved** badge means a change has not reached the server yet. ![x](/help/en/a.png)\n\nPress [Save](#help:notes) when ready.",
  ),
  art(
    "arabic",
    "حفظ التغييرات",
    ["حفظ"],
    ["التغييرات غير المحفوظة"],
    "تُحفَظ تعديلاتك على هذا الجهاز. تظهر شارة عندما لا يكون التغيير قد وصل إلى الخادم بعد.",
  ),
];

test("unsaved ranks the save-and-sync article first, with a clean snippet", () => {
  const hits = searchHelp(fixture, "unsaved");
  assert.equal(hits[0].article.id, "save-and-sync");
  assert.match(hits[0].snippet, /unsaved badge/);
  assert.doesNotMatch(hits[0].snippet, /[*\]\[]/);
});

test("prefix match: save matches saving", () => {
  assert.equal(searchHelp(fixture, "save")[0].article.id, "save-and-sync");
  assert.ok(searchHelp(fixture, "sav").some((h) => h.article.id === "save-and-sync"));
});

test("Arabic diacritics do not change the result", () => {
  const plain = searchHelp(fixture, "حفظ").map((h) => h.article.id);
  const marked = searchHelp(fixture, "حَفْظ").map((h) => h.article.id);
  assert.deepEqual(marked, plain);
  assert.equal(plain[0], "arabic");
});

test("empty and one-character queries return nothing", () => {
  assert.deepEqual(searchHelp(fixture, ""), []);
  assert.deepEqual(searchHelp(fixture, "  "), []);
  assert.deepEqual(searchHelp(fixture, "s"), []);
});

test("no match returns nothing; limit applies", () => {
  assert.deepEqual(searchHelp(fixture, "zzzz"), []);
  assert.equal(searchHelp(fixture, "the", 1).length <= 1, true);
});
