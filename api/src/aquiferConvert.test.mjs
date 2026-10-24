// Unit tests for the Aquifer -> en_tn converter (aquiferConvert.ts).
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/aquiferConvert.test.mjs
//
// Fixtures are compact but use REAL Aquifer markup shapes: a leading ltr/rtl
// original-language quote span, a bold gloss, prose, and a trailing "(See: <TA>)"
// resourceReference paragraph.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convertAquiferBook,
  ordinalOf,
  embeddedQuote,
  aquiferRef,
  htmlToMarkdown,
  nfc,
  planFormattingRepair,
  legacyHtmlToMarkdown,
} from "./aquiferConvert.ts";
import { parseEnglishTitle } from "./aquiferLinks.ts";

const en = (Reference, ID, SupportReference, Quote, Occurrence, Note) => ({
  Reference, ID, Tags: "", SupportReference, Quote, Occurrence, Note,
});
const aq = (title, index_reference, start, content, end) => ({
  content_id: `c-${title}`,
  title,
  index_reference,
  content,
  associations: { passage: [{ start_ref_usfm: start, end_ref_usfm: end ?? start }] },
});
const noteHtml = (quote, dir, gloss, prose) =>
  `<p><strong><span style='direction: ${dir};'>${quote}</span></strong></p>` +
  `<p><strong>&quot;</strong><span><strong>${gloss}</strong></span><strong>&quot;</strong></p>` +
  `<p>${prose}</p>` +
  `<p>See: <span data-bnType="resourceReference" data-resourceId="26687" data-resourceType="UWTranslationManual">Assumed Knowledge</span></p>`;

test("ordinalOf handles #N, N# (RTL flip) and Arabic-indic/Devanagari digits", () => {
  assert.equal(ordinalOf("3 John 1:1 (#1)"), 1);
  assert.equal(ordinalOf("تيطس 1:1 (1#)"), 1);
  assert.equal(ordinalOf("راعوث ١:١ (#٢)"), 2);
  assert.equal(ordinalOf("यहूदा 1:1 (#३)"), 3);
  assert.equal(ordinalOf("Ruth - Introduction"), null);
});

test("embeddedQuote pulls the first ltr(Greek)/rtl(Hebrew) span, NFC-trimmed", () => {
  assert.equal(embeddedQuote("<p><span style='direction: ltr;'>ὁ πρεσβύτερος</span></p>"), "ὁ πρεσβύτερος");
  assert.equal(embeddedQuote("<span style='direction: rtl;'>בִּ⁠ימֵי֙</span>"), nfc("בִּ⁠ימֵי֙"));
  assert.equal(embeddedQuote("<p>no span here</p>"), "");
});

test("aquiferRef maps book intro, chapter intro, verse, and range", () => {
  assert.deepEqual(aquiferRef({ index_reference: "08000000", associations: { passage: [{ start_ref_usfm: "RUT 0:1" }] } }), { ref: "front:intro", isIntro: true });
  assert.deepEqual(aquiferRef({ index_reference: "08Ruth000", associations: { passage: [{ start_ref_usfm: "RUT 2:1" }] } }), { ref: "2:intro", isIntro: true });
  assert.deepEqual(aquiferRef({ index_reference: "08001001", associations: { passage: [{ start_ref_usfm: "RUT 1:1" }] } }), { ref: "1:1", isIntro: false });
  assert.deepEqual(aquiferRef({ index_reference: "08001002", associations: { passage: [{ start_ref_usfm: "RUT 1:2", end_ref_usfm: "RUT 1:8" }] } }), { ref: "1:2-8", isIntro: false });
  assert.deepEqual(aquiferRef({ index_reference: "64001006-64001007", associations: { passage: [{ start_ref_usfm: "3JN 1:6", end_ref_usfm: "3JN 1:7" }] } }), { ref: "1:6-7", isIntro: false });
});

test("htmlToMarkdown strips leading quote + trailing See-link, keeps prose", () => {
  const md = htmlToMarkdown(noteHtml("ὁ πρεσβύτερος", "ltr", "the elder", "John assumes Gaius knows who he is."));
  assert.ok(!md.includes("πρεσβύτερος"), "orig-language quote paragraph removed");
  assert.ok(!md.includes("resourceReference") && !md.includes("Assumed Knowledge"), "trailing See:TA removed");
  assert.ok(md.includes("John assumes Gaius knows who he is."), "prose kept");
  assert.ok(md.includes('**"the elder"**'), "split-strong gloss is one bold run");
});

// Regression: arb MRK 3:1 (Aquifer note 197002) imported as
// `…ترك****ثُمَّ من دون…` — the quotation marks around the gloss are their own
// <strong> runs, and the padding space is an emphasised space, so converting
// each run on its own emitted stray `****` and glued two words together.
test("htmlToMarkdown merges split/whitespace-only emphasis instead of emitting ****", () => {
  const md = htmlToMarkdown(
    "<p><strong><span style='direction: ltr;'>καὶ</span></strong></p>" +
      "<p><strong>&quot;ثُمَّ&quot;</strong></p>" +
      "<p>تُقدّم كلمة <span><strong>ثُمَّ</strong></span> هنا، أو يمكنك ترك<strong> </strong><span>ثُمَّ</span> من دون ترجمة.</p>",
  );
  assert.ok(!md.includes("****"), `no stray asterisk run: ${md}`);
  assert.ok(md.includes("ترك ثُمَّ من دون"), "emphasised padding space survives as a space");
  assert.ok(md.includes("**ثُمَّ**"), "real bold survives");
});

test("htmlToMarkdown keeps emphasis markers hugging their text", () => {
  assert.equal(htmlToMarkdown("<p>a<strong> bold </strong>b</p>"), "a **bold** b");
  assert.equal(htmlToMarkdown("<p><strong>&quot;</strong><strong>x</strong><strong>&quot;</strong></p>"), '**"x"**');
  assert.equal(htmlToMarkdown("<p>a<em> </em>b</p>"), "a b");
});

test("htmlToMarkdown keeps headings/lists for intros", () => {
  const md = htmlToMarkdown("<h1>Introduction to Ruth</h1><h2>Part 1</h2><ol><li>Outline point</li></ol>", { isIntro: true });
  assert.ok(md.includes("# Introduction to Ruth"));
  assert.ok(md.includes("## Part 1"));
  assert.ok(md.includes("- Outline point"));
});

test("quote-primary: unique Greek quote match inherits en columns, no flag (language-independent)", () => {
  const enRows = [
    en("front:intro", "kwv9", "", "", "0", "# Intro"),
    en("1:1", "w99t", "rc://*/ta/man/translate/figs-explicit", "ὁ πρεσβύτερος", "1", "The elder..."),
  ];
  const items = [
    aq("3 यूहन्ना - परिचय", "64000000", "3JN 0:1", "<h1>परिचय</h1>"),
    aq("3 यूहन्ना 1:1 (#1)", "64001001", "3JN 1:1", noteHtml("ὁ πρεσβύτερος", "ltr", "प्राचीन", "यूहन्ना मानता है...")),
  ];
  const { notes, report } = convertAquiferBook(items, enRows);
  const r = notes.find((n) => n.enId === "w99t");
  assert.equal(r.joinMethod, "quote");
  assert.equal(r.reviewReason, null);
  assert.equal(r.supportReference, "rc://*/ta/man/translate/figs-explicit");
  assert.equal(r.quote, "ὁ πρεσβύτερος");
  assert.equal(r.occurrence, 1);
  assert.ok(r.note.includes("यूहन्ना मानता है"));
  assert.equal(report.matchedQuote, 1);
  assert.equal(report.matchedIntro, 1);
});

test("ordinal fallback flags for review when the quote does not match en", () => {
  const enRows = [
    en("1:1", "aaaa", "rc://*/ta/man/translate/figs-x", "מֵ⁠אֹ֥הֶל מוֹעֵ֖ד", "1", "from the tent"),
  ];
  const items = [
    aq("Leviticus 1:1 (#1)", "03001001", "LEV 1:1", noteHtml("לֵ⁠אמֹֽר׃ דַּבֵּ֞ר", "rtl", "saying", "Address the sons of Israel.")),
  ];
  const { notes, report } = convertAquiferBook(items, enRows);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].joinMethod, "ordinal");
  assert.ok(notes[0].reviewReason && notes[0].reviewReason.length > 0, "flagged for review");
  assert.equal(notes[0].enId, "aaaa");
  assert.equal(report.matchedOrdinal, 1);
  assert.equal(report.flagged, 1);
});

test("repeated quote at a ref: notes zip in order to the en Occurrences", () => {
  const enRows = [
    en("1:5", "id-a", "", "λόγος", "1", "n1"),
    en("1:5", "id-b", "", "λόγος", "2", "n2"),
  ];
  const items = [
    aq("Book 1:5 (#1)", "40001005", "X 1:5", noteHtml("λόγος", "ltr", "word", "first occurrence prose")),
    aq("Book 1:5 (#2)", "40001005", "X 1:5", noteHtml("λόγος", "ltr", "word", "second occurrence prose")),
  ];
  const { notes } = convertAquiferBook(items, enRows);
  assert.equal(notes[0].occurrence, 1);
  assert.ok(notes[0].note.includes("first occurrence"));
  assert.equal(notes[1].occurrence, 2);
  assert.ok(notes[1].note.includes("second occurrence"));
});

test("unmatched Aquifer note (no en_tn row) is returned minted + flagged with extracted quote", () => {
  const enRows = [en("2:1", "other", "", "χάρις", "1", "grace")];
  const items = [
    aq("Book 1:1 (#1)", "40001001", "X 1:1", noteHtml("ἀρχή", "ltr", "beginning", "unmatched prose")),
  ];
  const { notes, report } = convertAquiferBook(items, enRows);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].joinMethod, "unmatched");
  assert.equal(notes[0].enId, null);
  assert.equal(notes[0].quote, "ἀρχή");
  assert.ok(notes[0].reviewReason, "flagged");
  assert.ok(notes[0].note.includes("unmatched prose"));
  assert.equal(report.unmatched, 1);
  assert.equal(report.flagged, 1);
});

test("intro note attaches to front:intro / N:intro rows without a flag", () => {
  const enRows = [
    en("front:intro", "i0", "", "", "0", "# en book intro"),
    en("1:intro", "i1", "", "", "0", "# en ch1 intro"),
  ];
  const items = [
    aq("Ruth - Introduction", "08000000", "RUT 0:1", "<h1>Introduction to Ruth</h1>"),
    aq("Ruth intro - chapter 1", "08Ruth000", "RUT 1:1", "<h2>Chapter 1 notes</h2>"),
  ];
  const { notes, report } = convertAquiferBook(items, enRows);
  assert.equal(notes.find((n) => n.enId === "i0").joinMethod, "intro");
  assert.equal(notes.find((n) => n.enId === "i1").joinMethod, "intro");
  assert.equal(notes.find((n) => n.enId === "i1").reviewReason, null);
  assert.equal(report.matchedIntro, 2);
  assert.equal(report.flagged, 0);
});

// Regression: `<(?:strong|b)[^>]*>` also matches `<br>` (and `<(?:em|i)…>`
// matches `<img>`), so the emphasis merge used to swallow a line break between
// two bold runs — re-creating the very word-gluing this file fixes.
test("htmlToMarkdown keeps a line break between emphasis runs", () => {
  assert.equal(htmlToMarkdown("<p><strong>Title</strong><br>body text</p>"), "**Title**\nbody text");
  assert.equal(
    htmlToMarkdown("<p><strong>Title</strong><br>body <strong>x</strong> end</p>"),
    "**Title**\nbody **x** end",
  );
});

test("htmlToMarkdown drops an empty emphasis tag without inserting a space", () => {
  assert.equal(htmlToMarkdown("<p>foo<strong></strong>bar</p>"), "foobar");
  assert.equal(htmlToMarkdown("<p>a<em></em>b</p>"), "ab");
});

// ---------- formatting repair of already-imported rows ----------

// The real arb MRK 3:1 markup (Aquifer note 197002): a bold gloss whose quote
// marks are their own runs, and an emphasised space between two words.
const REPAIR_HTML =
  "<p><strong><span style='direction: ltr;'>καὶ</span></strong></p>" +
  "<p><strong>&quot;</strong><span><strong>then</strong></span><strong>&quot;</strong></p>" +
  "<p>Mark introduces the next event. You may leave<strong> </strong><span>then</span> untranslated.</p>";
const REPAIR_ITEM = {
  content_id: "197002",
  index_reference: "41003001",
  content: REPAIR_HTML,
  associations: { passage: [{ start_ref_usfm: "MRK 3:1", end_ref_usfm: "MRK 3:1" }] },
};
// What the pre-fix converter wrote into D1 for that note, and what it should be.
const DAMAGED = '**"****then****"**\n\nMark introduces the next event. You may leave****then untranslated.';
const FIXED = '**"then"**\n\nMark introduces the next event. You may leave then untranslated.';
const aqMeta = (over) => JSON.stringify({ source: "aquifer", aqLang: "arb", aquiferContentId: "197002", joinMethod: "quote", ...over });
const storedRow = (over) => ({ id: "bm6z", version: 3, note: DAMAGED, draftMetaJson: aqMeta(), preDraftJson: null, ...over });

// The frozen legacy render is the repair's whole safety proof — if it ever
// drifts from what actually went into D1, the repair stops matching (safe) or
// matches something it shouldn't (not safe). Pin both renders.
test("legacyHtmlToMarkdown still reproduces the damaged text the fix replaced", () => {
  assert.equal(legacyHtmlToMarkdown(REPAIR_HTML), DAMAGED);
  assert.equal(htmlToMarkdown(REPAIR_HTML), FIXED);
});

test("planFormattingRepair rewrites a row that is still the old converter's exact output", () => {
  const { repairs, report } = planFormattingRepair([storedRow()], [REPAIR_ITEM], "arb");
  assert.equal(report.repaired, 1);
  assert.equal(repairs[0].id, "bm6z");
  assert.equal(repairs[0].version, 3, "carries the version for the CAS guard");
  assert.equal(repairs[0].note, FIXED);
  assert.equal(repairs[0].before, DAMAGED, "damaged text travels to the audit row");
});

test("planFormattingRepair never touches a note a human changed", () => {
  const reworded = DAMAGED.replace("next event", "following event");
  const worded = planFormattingRepair([storedRow({ note: reworded })], [REPAIR_ITEM], "arb");
  assert.deepEqual(worded.repairs, []);
  assert.equal(worded.report.humanEdited, 1);

  // Formatting-only human edits count too: moving a bold or splitting a
  // paragraph is deliberate work, and an asterisk-blind comparison would
  // silently revert it.
  const remphasised = DAMAGED.replace('**"****then****"**', 'then is emphasised **here** instead');
  assert.equal(planFormattingRepair([storedRow({ note: remphasised })], [REPAIR_ITEM], "arb").report.humanEdited, 1);
  const resplit = DAMAGED.replace("the next event.", "the next event.\n\n");
  assert.equal(planFormattingRepair([storedRow({ note: resplit })], [REPAIR_ITEM], "arb").report.humanEdited, 1);
});

test("planFormattingRepair skips clean, non-Aquifer, other-language, and unknown-source rows", () => {
  const { repairs, report } = planFormattingRepair([
    storedRow({ id: "aaaa", note: FIXED }),
    { id: "bbbb", version: 1, note: DAMAGED, draftMetaJson: JSON.stringify({ source: "ai" }), preDraftJson: null },
    { id: "cccc", version: 1, note: DAMAGED, draftMetaJson: null, preDraftJson: null },
    storedRow({ id: "dddd", draftMetaJson: aqMeta({ aquiferContentId: "999999" }) }),
    storedRow({ id: "eeee", draftMetaJson: aqMeta({ aqLang: "hin" }) }),
  ], [REPAIR_ITEM], "arb");
  assert.deepEqual(repairs, []);
  assert.equal(report.aquiferRows, 3, "only rows stamped source=aquifer are considered");
  assert.equal(report.alreadyClean, 1);
  assert.equal(report.noSource, 1);
  assert.equal(report.otherLang, 1);
});

test("planFormattingRepair repairs the approval snapshot, and survives a junk one", () => {
  const approved = planFormattingRepair(
    [storedRow({ preDraftJson: JSON.stringify({ note: DAMAGED, tags: null }) })],
    [REPAIR_ITEM], "arb",
  );
  assert.deepEqual(JSON.parse(approved.repairs[0].preDraftJson), { note: FIXED, tags: null });

  for (const junk of [JSON.stringify({ note: "", tags: null }), JSON.stringify({ note: 42 }), "[]", "not json"]) {
    const r = planFormattingRepair([storedRow({ preDraftJson: junk })], [REPAIR_ITEM], "arb");
    assert.equal(r.repairs[0].preDraftJson, null, `snapshot left alone: ${junk}`);
    assert.equal(r.repairs[0].note, FIXED, "the note itself is still repaired");
  }
});

// ---------- English-link join (primary key) ----------

// PHM 1:1 shape: two en_tn rows on the SAME words. Quote-first cannot tell the
// notes apart and hands the first row to whichever note it sees first.
const phmRows = () => [
  en("1:1", "mtph", "rc://*/ta/man/translate/figs-metaphor", "ὁ ἀδελφὸς", "1", "metaphor note"),
  en("1:1", "excl", "rc://*/ta/man/translate/figs-exclusive", "ὁ ἀδελφὸς", "1", "exclusive note"),
];
const links = (pairs) => new Map(pairs.map(([id, title]) => [id, { engContentId: `e-${id}`, engTitle: title }]));

test("parseEnglishTitle reads reference + ordinal, ranges too, and rejects intros", () => {
  assert.deepEqual(parseEnglishTitle("Titus 1:1 (#1)"), { ref: "1:1", ordinal: 1 });
  assert.deepEqual(parseEnglishTitle("1 John 2:3-5 (#12)"), { ref: "2:3-5", ordinal: 12 });
  assert.equal(parseEnglishTitle("Titus - Introduction"), null);
  assert.equal(parseEnglishTitle("Titus - Chapter 1 Introduction"), null);
  assert.equal(parseEnglishTitle(undefined), null);
});

test("link join: two rows on the same quote each get their own note (quote-first would swap them)", () => {
  // Aquifer order is the reverse of en_tn order: the exclusive note comes first.
  const items = [
    aq("फिलेमोन 1:1 (#4)", "57001001", "PHM 1:1", noteHtml("ὁ ἀδελφὸς", "ltr", "x", "exclusive prose")),
    aq("फिलेमोन 1:1 (#3)", "57001001", "PHM 1:1", noteHtml("ὁ ἀδελφὸς", "ltr", "y", "metaphor prose")),
  ];
  // English numbers match en_tn order (#1 = first row at 1:1); Hindi's do not.
  const l = links([["c-फिलेमोन 1:1 (#4)", "Philemon 1:1 (#2)"], ["c-फिलेमोन 1:1 (#3)", "Philemon 1:1 (#1)"]]);
  const { notes, report } = convertAquiferBook(items, phmRows(), l);
  const byProse = (t) => notes.find((n) => n.note.includes(t));
  assert.equal(byProse("exclusive prose").enId, "excl");
  assert.equal(byProse("exclusive prose").supportReference, "rc://*/ta/man/translate/figs-exclusive");
  assert.equal(byProse("metaphor prose").enId, "mtph");
  assert.equal(byProse("metaphor prose").supportReference, "rc://*/ta/man/translate/figs-metaphor");
  assert.ok(notes.every((n) => n.joinMethod === "link" && n.reviewReason === null));
  assert.equal(report.matchedLink, 2);
  assert.equal(report.matchedQuote, 0);

  // Control: the same data without links takes quote-first and swaps them.
  const swapped = convertAquiferBook(items, phmRows()).notes;
  assert.equal(swapped.find((n) => n.note.includes("exclusive prose")).enId, "mtph");
});

test("link join flags a note whose quote differs from the linked row's", () => {
  const items = [aq("Leviticus 1:1 (#1)", "03001001", "LEV 1:1", noteHtml("לֵ⁠אמֹֽר׃ דַּבֵּ֞ר", "rtl", "saying", "Address."))];
  const rows = [en("1:1", "aaaa", "rc://*/ta/man/translate/figs-x", "מֵ⁠אֹ֥הֶל מוֹעֵ֖ד", "1", "from the tent")];
  const { notes, report } = convertAquiferBook(items, rows, links([["c-Leviticus 1:1 (#1)", "Leviticus 1:1 (#1)"]]));
  assert.equal(notes[0].joinMethod, "link");
  assert.equal(notes[0].enId, "aaaa");
  assert.ok(notes[0].reviewReason, "quote mismatch is flagged");
  assert.equal(report.matchedLink, 1);
  assert.equal(report.flagged, 1);
});

test("a link pointing past the en_tn rows, or with no link at all, falls back to quote then ordinal", () => {
  const rows = [en("1:1", "aaaa", "rc://*/ta/man/translate/figs-x", "ὁ πρεσβύτερος", "1", "n")];
  const items = [
    aq("a 1:1 (#1)", "64001001", "3JN 1:1", noteHtml("ὁ πρεσβύτερος", "ltr", "g", "linked past the end")),
    aq("b 1:1 (#2)", "64001001", "3JN 1:1", noteHtml("ἄλλο", "ltr", "g", "no link")),
  ];
  const l = links([["c-a 1:1 (#1)", "X 1:1 (#9)"]]);
  const { notes, report } = convertAquiferBook(items, rows, l);
  const a = notes.find((n) => n.note.includes("linked past the end"));
  assert.equal(a.joinMethod, "quote");
  assert.equal(a.enId, "aaaa");
  assert.equal(notes.find((n) => n.note.includes("no link")).joinMethod, "unmatched"); // row already taken
  assert.equal(report.matchedLink, 0);
});

test("a linked note claims its row before a quote match can take it", () => {
  // Two notes quote the same words; only one is linked. The linked one must get
  // its own row even though the other is first in Aquifer order.
  const items = [
    aq("n 1:1 (#7)", "57001001", "PHM 1:1", noteHtml("ὁ ἀδελφὸς", "ltr", "x", "unlinked")),
    aq("n 1:1 (#8)", "57001001", "PHM 1:1", noteHtml("ὁ ἀδελφὸς", "ltr", "y", "linked to second")),
  ];
  const l = links([["c-n 1:1 (#8)", "Philemon 1:1 (#1)"]]);
  const { notes } = convertAquiferBook(items, phmRows(), l);
  assert.equal(notes.find((n) => n.note.includes("linked to second")).enId, "mtph");
  assert.equal(notes.find((n) => n.note.includes("unlinked")).enId, "excl");
});

test("link to a row whose quote disagrees yields to an exact quote match on a free row (en_tn drifted from the pinned release)", () => {
  // The link says "#1", but en_tn has since gained a row in front, so row 1 is
  // not the note Aquifer meant. The note's quote matches row 2 exactly.
  const rows = [
    en("1:1", "newr", "rc://*/ta/man/translate/figs-new", "ἄλλο", "1", "added after the release"),
    en("1:1", "mtph", "rc://*/ta/man/translate/figs-metaphor", "ὁ ἀδελφὸς", "1", "metaphor note"),
  ];
  const items = [aq("n 1:1 (#1)", "57001001", "PHM 1:1", noteHtml("ὁ ἀδελφὸς", "ltr", "x", "prose"))];
  const { notes, report } = convertAquiferBook(items, rows, links([["c-n 1:1 (#1)", "Philemon 1:1 (#1)"]]));
  assert.equal(notes[0].enId, "mtph");
  assert.equal(notes[0].joinMethod, "quote");
  assert.equal(notes[0].reviewReason, null);
  assert.equal(report.matchedLink, 0);
});

test("link whose English reference differs from the note's own reference is flagged", () => {
  const rows = [en("1:2", "aaaa", "rc://*/ta/man/translate/figs-x", "ὁ ἀδελφὸς", "1", "n")];
  const items = [aq("n 1:1 (#1)", "57001001", "PHM 1:1", noteHtml("ὁ ἀδελφὸς", "ltr", "x", "prose"))];
  const { notes } = convertAquiferBook(items, rows, links([["c-n 1:1 (#1)", "Philemon 1:2 (#1)"]]));
  assert.equal(notes[0].joinMethod, "link");
  assert.ok(notes[0].reviewReason, "reference disagreement is flagged even when the quote matches");
});
