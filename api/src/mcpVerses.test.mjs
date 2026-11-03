// Issue #783: the chat MCP tool bpt_get_verses, which shows a reviewer the
// project's verse text as plain text beside the note they are reading.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/mcpVerses.test.mjs
//
// The chapter payload is stubbed the way the chapter route serves it
// (verses[lane][verse] = { verse, verse_end, content }), with content parsed by
// the real usfm-js from USFM text, so the node shapes are the real ones:
// opening quotes parked on a \q marker's text, \zaln-s milestones nesting the
// \w words, footnotes as their own node, \ts\* as a trailing node.

import { test } from "node:test";
import assert from "node:assert/strict";
import usfm from "usfm-js";

import { dispatch } from "./mcp.ts";
import { PAGE_BYTE_BUDGET, ROW_TEXT_CAP, byteLength } from "./mcpTools.ts";

const TOKEN = "bpt_" + "g".repeat(43);

// Parse one chapter of USFM into the chapter route's per-lane verse map. A
// bridged verse ("3-4") becomes one entry keyed by its first verse, with
// verse_end, as the route keys it.
// The chapter-front entry ("front": a Psalm superscription, or just a \p) is
// stored as verse 0 (scripts/import-book.mjs, importParsers.ts).
function laneFrom(chapterUsfm, { book = "TIT", chapter = 1 } = {}) {
  const json = usfm.toJSON(`\\id ${book}\n\\c ${chapter}\n${chapterUsfm}`);
  const out = {};
  for (const [key, v] of Object.entries(json.chapters[String(chapter)])) {
    if (key === "front") {
      out[0] = { verse: 0, verse_end: null, content: v };
      continue;
    }
    const [s, e] = key.split("-").map(Number);
    out[s] = { verse: s, verse_end: e ?? null, content: v };
  }
  return out;
}

const W = (word) => `\\w ${word}|x-occurrence="1" x-occurrences="1"\\w*`;
const ZALN = (lemma, inner) =>
  `\\zaln-s |x-strong="G1" x-lemma="${lemma}" x-occurrence="1" x-occurrences="1" x-content="${lemma}"\\*${inner}\\zaln-e\\*`;

// TIT 1: aligned ULT (nested \zaln-s), a footnote, a quote parked on a \q1
// marker, a \ts\* marker, a bridged verse 3-4 and a plain verse 5.
const ULT_TIT1 = laneFrom(
  [
    "\\p",
    `\\v 1 ${ZALN("Παῦλος", W("Paul"))}, ${ZALN("δοῦλος", `${ZALN("θεοῦ", `${W("a")} ${W("servant")}`)}`)} of God\\f + \\ft Or: a slave.\\f*.`,
    `\\q1 “${W("Hello")},” he said.`,
    "\\ts\\*",
    `\\v 2 ${W("In")} ${W("hope")}.`,
    "\\v 3-4 {Bridged} verses here.",
    "\\v 5 The end.",
  ].join("\n"),
);
const UST_TIT1 = laneFrom("\\p\n\\v 1 Paul writes this letter.\n\\v 2 He hopes.");
const UHB_TIT1 = laneFrom("\\p\n\\v 1 Παῦλος δοῦλος θεοῦ\n\\v 2 ἐπ᾽ ἐλπίδι");

// A long chapter: 60 verses of 400 Arabic letters each (two bytes a letter),
// well over the page budget in total.
const LONG = laneFrom(
  Array.from({ length: 60 }, (_, i) => `\\v ${i + 1} ${"ب".repeat(399)}${i + 1}`).join("\n"),
);
// Unaligned text: a footnote and a cross reference followed by plain text
// (usfm-js keeps the space after \f* / \x* on the note node as nextChar), and
// headings that usfm-js parks at the end of the verse BEFORE the one they head.
const NOTES_AND_HEADINGS = laneFrom(
  [
    "\\p",
    "\\v 1 Grace\\f + \\ft Or: favor.\\f* to you, and\\x - \\xo 1:1 \\xt Gen 1:1\\x* peace.",
    "\\qa BETH",
    "\\s1 A section heading",
    "\\v 2 Next verse.",
    "\\lit Lord, have mercy.",
    "\\v 3 Last.",
  ].join("\n"),
);
// Psalms 2-3 as real USFM: chapter 3's superscription \d sits after \c and
// before \v 1, so usfm-js puts it in chapter 3's front entry (verse 0).
const PSA = usfm.toJSON(
  [
    "\\id PSA",
    "\\c 2",
    "\\q1",
    "\\v 12 Blessed are all who take refuge in him.",
    "\\c 3",
    "\\d A psalm of David, when he fled from Absalom his son.",
    "\\q1",
    "\\v 1 Yahweh, how many are my enemies!",
    "\\q2 Many are rising up against me.",
    "\\v 2 Many say of me,",
  ].join("\n"),
);
function laneOf(chapterJson) {
  const out = {};
  for (const [key, v] of Object.entries(chapterJson)) {
    const s = key === "front" ? 0 : Number(key);
    out[s] = { verse: s, verse_end: null, content: v };
  }
  return out;
}
// Verses full of straight quotes and backslashes: each costs 1 byte in the
// text, 2 in the tool's JSON, and 4 once mcp.ts encodes that JSON again.
const ESCAPES = Object.fromEntries(
  Array.from({ length: 60 }, (_, i) => [
    i + 1,
    { verse: i + 1, verse_end: null, content: { verseObjects: [{ type: "text", text: `${'"\\'.repeat(200)}${i + 1}` }] } },
  ]),
);
// One verse longer than a row may be on its own.
const HUGE = laneFrom(`\\v 1 ${"x".repeat(ROW_TEXT_CAP + 500)}`);

const CHAPTERS = {
  "/api/chapters/TIT/1": { verses: { ULT: ULT_TIT1, UST: UST_TIT1, UGNT: UHB_TIT1 } },
  "/api/chapters/TIT/2": { verses: { UST: UST_TIT1, UGNT: UHB_TIT1 } }, // no ULT
  "/api/chapters/TIT/3": { verses: { UGNT: UHB_TIT1 } }, // source text only
  "/api/chapters/TIT/4": { verses: {} }, // nothing
  "/api/chapters/TIT/5": { verses: { ULT: LONG } },
  "/api/chapters/TIT/6": { verses: { ULT: HUGE } },
  "/api/chapters/TIT/7": { verses: { ULT: NOTES_AND_HEADINGS } },
  "/api/chapters/TIT/8": { verses: { ULT: ESCAPES } },
  "/api/chapters/PSA/2": { verses: { ULT: laneOf(PSA.chapters["2"]) } },
  "/api/chapters/PSA/3": { verses: { ULT: laneOf(PSA.chapters["3"]) } },
};

const calls = [];
const session = {
  workspace: { slug: "mltest", label: "ML", org: "ML" },
  principal: { userId: 1, username: "ada", role: null, linkId: 1 }, // a viewer: reads only
  getJson: async (path) => {
    calls.push(path);
    const body = CHAPTERS[path];
    return body ? { status: 200, body } : { status: 404, body: { error: "not_found" } };
  },
  send: async () => {
    throw new Error("bpt_get_verses must not write");
  },
  sendAsAdmin: async () => {
    throw new Error("bpt_get_verses must not write");
  },
};
const toolCtx = { session: async (t) => (t === TOKEN ? session : null), claimLink: async () => ({ ok: false }) };

async function call(args, token = TOKEN) {
  const reply = await dispatch(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "bpt_get_verses", arguments: token ? { session_token: token, ...args } : args },
    },
    toolCtx,
  );
  return { isError: reply.result.isError === true, data: JSON.parse(reply.result.content[0].text), wire: JSON.stringify(reply) };
}

test("tools/list advertises bpt_get_verses as a read that needs the session token", async () => {
  const reply = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" }, toolCtx);
  const tool = reply.result.tools.find((t) => t.name === "bpt_get_verses");
  assert.ok(tool, "listed");
  assert.deepEqual(tool.inputSchema.required, ["session_token", "book", "chapter"]);
});

test("ULT text as plain text: alignment and footnotes gone, quotes and punctuation on markers kept", async () => {
  const r = await call({ book: "tit", chapter: 1, verse_start: 1, verse_end: 5 });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.book, "TIT");
  assert.equal(r.data.chapter, 1);
  assert.equal(r.data.lane, "ULT");
  assert.equal(r.data.note, null);
  assert.equal(r.data.next_verse_start, null);
  assert.deepEqual(r.data.verses, [
    // The “ sits on the \q1 marker node's own text, not on a word.
    { verse: 1, text: "Paul, a servant of God. “Hello,” he said." },
    { verse: 2, text: "In hope." },
    { verse: 3, verse_end: 4, text: "{Bridged} verses here." },
    { verse: 5, text: "The end." },
  ]);
  assert.equal(r.data.total, 4);
  assert.equal(r.data.returned, 4);
  assert.deepEqual(calls.at(-1), "/api/chapters/TIT/1", "one read of the chapter route");
  assert.ok(!/zaln|\\w|\\f|footnote|slave/.test(r.wire), "no USFM, alignment or footnote text on the wire");
});

test("the space after a footnote or cross reference survives; headings and \\lit are left out", async () => {
  const r = await call({ book: "TIT", chapter: 7 });
  assert.deepEqual(r.data.verses, [
    // Without nextChar this read "Graceto you, andpeace.", and without
    // dropping headings it ended "... peace. BETH A section heading".
    { verse: 1, text: "Grace to you, and peace." },
    // usfm-js parks \lit (display text) on the verse before.
    { verse: 2, text: "Next verse." },
    { verse: 3, text: "Last." },
  ]);
});

test("a Psalm superscription comes back as verse 0 by default, on neither verse 1 nor the previous chapter", async () => {
  const r = await call({ book: "PSA", chapter: 3 });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.deepEqual(r.data.verses, [
    { verse: 0, text: "A psalm of David, when he fled from Absalom his son." },
    { verse: 1, text: "Yahweh, how many are my enemies! Many are rising up against me." },
    { verse: 2, text: "Many say of me," },
  ]);
  const prev = await call({ book: "PSA", chapter: 2 });
  assert.deepEqual(prev.data.verses, [{ verse: 12, text: "Blessed are all who take refuge in him." }]);
  const from1 = await call({ book: "PSA", chapter: 3, verse_start: 1, verse_end: 1 });
  assert.deepEqual(from1.data.verses.map((v) => v.verse), [1], "an explicit verse_start 1 leaves the front matter out");
  const only0 = await call({ book: "PSA", chapter: 3, verse_start: 0, verse_end: 0 });
  assert.deepEqual(only0.data.verses.map((v) => v.verse), [0]);
});

test("pages are measured as they travel: straight quotes and backslashes cost double", async () => {
  const seen = [];
  let start = 1;
  for (let pages = 1; ; pages++) {
    const r = await call({ book: "TIT", chapter: 8, verse_start: start });
    assert.equal(r.isError, false);
    assert.ok(Buffer.byteLength(r.wire) < 32_000, `page ${pages} travels in ${Buffer.byteLength(r.wire)} bytes`);
    seen.push(...r.data.verses.map((v) => v.verse));
    if (r.data.next_verse_start === null) break;
    start = r.data.next_verse_start;
    assert.ok(pages < 30, "paging terminates");
  }
  assert.deepEqual(seen, Array.from({ length: 60 }, (_, i) => i + 1));
});

test("a range: a bridged verse overlapping it is returned whole, once", async () => {
  const r = await call({ book: "TIT", chapter: 1, verse_start: 4, verse_end: 4 });
  assert.deepEqual(r.data.verses, [{ verse: 3, verse_end: 4, text: "{Bridged} verses here." }]);
  assert.equal(r.data.verse_start, 4);
  assert.equal(r.data.verse_end, 4);
  const whole = await call({ book: "TIT", chapter: 1 });
  assert.deepEqual(whole.data.verses.map((v) => v.verse), [1, 2, 3, 5], "no range: the whole chapter, verse 0 left out");
  assert.equal(whole.data.verse_end, null);
});

test("lane: pick another lane by name; an unknown lane names the ones there are", async () => {
  const ust = await call({ book: "TIT", chapter: 1, lane: "ust", verse_start: 1, verse_end: 1 });
  assert.equal(ust.data.lane, "UST");
  assert.equal(ust.data.note, null, "a lane the reviewer asked for needs no note");
  assert.deepEqual(ust.data.verses, [{ verse: 1, text: "Paul writes this letter." }]);
  const bad = await call({ book: "TIT", chapter: 1, lane: "XYZ" });
  assert.equal(bad.isError, true);
  assert.match(bad.data.error, /XYZ/);
  assert.match(bad.data.error, /ULT, UST, UGNT/);
});

test("no ULT: falls back like bpt_chunks and says which lane it used", async () => {
  const r = await call({ book: "TIT", chapter: 2, verse_start: 1, verse_end: 2 });
  assert.equal(r.data.lane, "UST");
  // ULT may exist for other chapters, so the note speaks of this one only.
  assert.equal(r.data.note, "ULT has no text for TIT 2 here, so the UST text was used.");
  assert.deepEqual(r.data.verses, [
    { verse: 1, text: "Paul writes this letter." },
    { verse: 2, text: "He hopes." },
  ]);
  const src = await call({ book: "TIT", chapter: 3 });
  assert.equal(src.data.lane, "UGNT");
  assert.match(src.data.note, /UGNT/);
  assert.equal(src.data.verses[0].text, "Παῦλος δοῦλος θεοῦ");
});

test("a chapter with no verses is a readable error", async () => {
  const r = await call({ book: "TIT", chapter: 4 });
  assert.equal(r.isError, true);
  assert.match(r.data.error, /no verses/);
  const missing = await call({ book: "TIT", chapter: 99 });
  assert.equal(missing.isError, true);
});

test("bad input is refused before any read", async () => {
  calls.length = 0;
  const backwards = await call({ book: "TIT", chapter: 1, verse_start: 5, verse_end: 2 });
  assert.equal(backwards.isError, true);
  assert.match(backwards.data.error, /verse_end/);
  const noBook = await call({ chapter: 1 });
  assert.equal(noBook.isError, true);
  const anon = await call({ book: "TIT", chapter: 1 }, null);
  assert.equal(anon.isError, true);
  assert.match(anon.data.error, /Link chat assistant/);
  assert.equal(calls.length, 0);
});

test("a long chapter is paged under the byte budget, with no verse lost or repeated", async () => {
  const seen = [];
  let start = 1;
  let pages = 0;
  for (;;) {
    const r = await call({ book: "TIT", chapter: 5, verse_start: start, verse_end: 60 });
    assert.equal(r.isError, false);
    pages++;
    assert.ok(byteLength(r.data) <= PAGE_BYTE_BUDGET + 1_000, `page ${pages} is ${byteLength(r.data)} bytes`);
    assert.ok(Buffer.byteLength(r.wire) < 32_000, `page ${pages} travels in ${Buffer.byteLength(r.wire)} bytes`);
    assert.equal(r.data.returned, r.data.verses.length);
    seen.push(...r.data.verses.map((v) => v.verse));
    for (const v of r.data.verses) assert.ok(v.text.endsWith(String(v.verse)), "the whole verse came back");
    if (r.data.next_verse_start === null) break;
    assert.equal(r.data.next_verse_start, r.data.verses.at(-1).verse + 1);
    start = r.data.next_verse_start;
    assert.ok(pages < 20, "paging terminates");
  }
  assert.ok(pages > 1, "the chapter took more than one page");
  assert.deepEqual(seen, Array.from({ length: 60 }, (_, i) => i + 1));
});

test("one verse longer than a row may be is cut and flagged, never dropped", async () => {
  const r = await call({ book: "TIT", chapter: 6 });
  assert.equal(r.data.verses.length, 1);
  assert.equal(r.data.verses[0].truncated, true);
  assert.ok(r.data.verses[0].text.length <= ROW_TEXT_CAP + 1);
  assert.equal(r.data.next_verse_start, null);
});
