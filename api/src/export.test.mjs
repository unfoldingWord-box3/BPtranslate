// Smoke test for export.ts buildUsfm. Run from api/:
//   node --experimental-strip-types --no-warnings src/export.test.mjs
//
// Asserts that multi-verse blocks (verse_end > verse) round-trip as `\v 6-9`
// instead of getting silently flattened to `\v 6`. Not a test framework;
// failures exit non-zero.

import { buildChapterExportBranch, buildExportBranch, buildTnTsv, buildTwlTsv, buildUsfm, commitToDcs, ensureDcsPr, exportTsvShrinkRefused, findDcsOpenPr, missingMasterIdCount, masterFetchGate, recreateExportBranchFromMaster, updateDcsPrBranch, usfmAlignmentShrinkRefused } from "./export.ts";
import { CorruptContentJsonError } from "./contentJson.ts";
import { extractVersesForRange } from "./importParsers.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

function mkVerse(chapter, verse, verseEnd, text) {
  return {
    book: "ISA",
    chapter,
    verse,
    verse_end: verseEnd,
    bible_version: "UST",
    content_json: JSON.stringify({
      verseObjects: [{ type: "text", text: `${text} ` }],
    }),
    plain_text: text,
    version: 1,
    updated_by: null,
    updated_at: 0,
  };
}

function utf8Base64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// --- Multi-verse block emits `\v 6-9` ---
{
  const out = buildUsfm({
    book: "ISA",
    bibleVersion: "UST",
    headers: null,
    verses: [
      mkVerse(1, 1, null, "first"),
      mkVerse(1, 6, 9, "combined six through nine"),
      mkVerse(1, 10, null, "tenth"),
    ],
  });
  assert(out.includes("\\v 6-9 "), `output contains \\v 6-9 marker`);
  assert(out.includes("combined six through nine"), `range content present`);
  assert(!out.match(/^\\v 7\b/m), `no spurious standalone \\v 7`);
  assert(!out.match(/^\\v 8\b/m), `no spurious standalone \\v 8`);
  assert(!out.match(/^\\v 9\b/m), `no spurious standalone \\v 9`);
  assert(out.match(/^\\v 1\b/m), `singleton \\v 1 still present`);
  assert(out.match(/^\\v 10\b/m), `singleton \\v 10 still present`);
}

// --- Singleton with verse_end=null still emits plain \v N ---
{
  const out = buildUsfm({
    book: "ISA",
    bibleVersion: "UST",
    headers: null,
    verses: [mkVerse(2, 5, null, "five")],
  });
  assert(out.match(/^\\v 5\b/m), `singleton emits \\v 5`);
  assert(!out.includes("\\v 5-"), `no hyphenated range emitted`);
}

// --- verse=0 chapter-front pseudo-verse still emits as "front" (regression) ---
{
  const front = {
    book: "PSA",
    chapter: 3,
    verse: 0,
    verse_end: null,
    bible_version: "ULT",
    content_json: JSON.stringify({
      verseObjects: [{ tag: "d", type: "section", text: "A psalm of David." }],
    }),
    plain_text: "A psalm of David.",
    version: 1,
    updated_by: null,
    updated_at: 0,
  };
  const out = buildUsfm({
    book: "PSA",
    bibleVersion: "ULT",
    headers: null,
    verses: [front, mkVerse(3, 1, null, "first")],
  });
  // usfm-js emits the chapter-front content above the first \v marker.
  assert(out.includes("A psalm of David."), `chapter-front content preserved`);
  assert(out.match(/^\\v 1\b/m), `first verse still emits after front`);
}

// --- Inverted verse_end (defensive) treats as singleton ---
{
  const out = buildUsfm({
    book: "ISA",
    bibleVersion: "UST",
    headers: null,
    // verse_end <= verse should fall through to singleton key
    verses: [mkVerse(1, 5, 5, "same"), mkVerse(1, 6, 3, "inverted")],
  });
  assert(out.match(/^\\v 5\b/m), `verse_end === verse emits as singleton`);
  assert(!out.includes("\\v 5-5"), `no \\v 5-5 emitted`);
  assert(out.match(/^\\v 6\b/m), `inverted verse_end emits as singleton`);
  assert(!out.includes("\\v 6-3"), `no \\v 6-3 emitted`);
}

// --- export heals malformed target occurrence (ULT/UST); leaves source (UHB) ---
{
  const verseRow = (bibleVersion, vos) => ({
    book: "NUM", chapter: 20, verse: 3, verse_end: null, bible_version: bibleVersion,
    content_json: JSON.stringify({ verseObjects: vos }),
    plain_text: "is is", version: 1, updated_by: null, updated_at: 0,
  });
  // The real corruption shape: two "is" both stamped occurrence="2"/occurrences="1".
  const corrupt = [
    { type: "word", tag: "w", text: "is", occurrence: "2", occurrences: "1" },
    { type: "text", text: " " },
    { type: "word", tag: "w", text: "is", occurrence: "2", occurrences: "1" },
  ];
  const ult = buildUsfm({ book: "NUM", bibleVersion: "ULT", headers: null, verses: [verseRow("ULT", corrupt)] });
  assert(ult.includes('x-occurrence="1" x-occurrences="2"'), `ULT export heals first "is" → 1/2`);
  assert(ult.includes('x-occurrence="2" x-occurrences="2"'), `ULT export heals second "is" → 2/2`);
  assert(!ult.includes('x-occurrences="1"'), `ULT export: no stale occurrences="1" shipped`);
  // UHB is the source text — its \w occurrence is emitted exactly as stored.
  const uhb = buildUsfm({ book: "NUM", bibleVersion: "UHB", headers: null, verses: [verseRow("UHB", corrupt)] });
  assert(uhb.includes('x-occurrence="2" x-occurrences="1"'), `UHB export leaves source occurrence verbatim`);
}

// --- export never writes a fake \x cross-reference built from `\w` attribute
// residue (issue #481: four invalid \x markers reached en_ust/24-JER.usfm) ---
{
  // The exact malformed master line (JER 30:3): the attribute section after the
  // `|` starts with a spurious backslash, and the trailing `.”` is trapped
  // inside the word. usfm-js reads that `\x` as a marker opener, so before the
  // fix the attribute residue left the word as a junk `{tag:"x"}` node and
  // export rendered it as a REAL `\x -occurrence="1" x-occurrences="1"\x*`.
  const malformed =
    '\\id JER\n\\c 30\n\\p\n\\v 3 \\zaln-s |x-strong="H3063" x-lemma="l" x-morph="He" ' +
    'x-occurrence="1" x-occurrences="1" x-content="Judah"\\*' +
    '\\w Judah.”|\\x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*\n';

  const ingested = extractVersesForRange(malformed, 30, 30).find((v) => v.verse === 3);
  const out = buildUsfm({
    book: "JER",
    bibleVersion: "UST",
    headers: null,
    verses: [{
      book: "JER", chapter: 30, verse: 3, verse_end: null, bible_version: "UST",
      content_json: ingested.contentJson, plain_text: ingested.plainText,
      version: 1, updated_by: null, updated_at: 0,
    }],
  });
  assert(!/\\x[ *]/.test(out), `no \\x cross-reference marker in the exported USFM (got ${JSON.stringify(out.split("\n").find((l) => l.startsWith("\\v 3")))})`);
  assert(out.includes('\\w Judah|x-occurrence="1" x-occurrences="1"\\w*.”'), `word/punctuation split still happens: \\w Judah\\w* then .” outside`);
  assert(out.includes("\\zaln-e\\*"), `the enclosing alignment milestone survives`);

  // Second line of defence: a row ALREADY stored in D1 from a pre-fix ingest
  // still carries the junk node. Export must drop it, not re-emit it.
  const stale = {
    book: "JER", chapter: 30, verse: 10, verse_end: null, bible_version: "UST",
    content_json: JSON.stringify({
      verseObjects: [{
        type: "milestone", tag: "zaln", strong: "H3063", lemma: "l", morph: "He",
        occurrence: "1", occurrences: "1", content: "Judah",
        children: [
          { type: "word", tag: "w", text: "Judah" },
          { type: "text", text: ".”" },
          { tag: "x", content: '-occurrence="1" x-occurrences="1"', nesting: 1 },
        ],
        endTag: "zaln-e\\*",
      }],
    }),
    plain_text: "Judah.”", version: 1, updated_by: null, updated_at: 0,
  };
  const staleOut = buildUsfm({ book: "JER", bibleVersion: "UST", headers: null, verses: [stale] });
  assert(!/\\x[ *]/.test(staleOut), `stored attribute residue is dropped, not exported as \\x`);
  assert(staleOut.includes("\\w Judah|"), `the word itself survives the residue drop`);
  assert(staleOut.includes(".”"), `the punctuation text node survives the residue drop`);

  // A REAL cross-reference is prose with its own inner markers — never dropped.
  const realXref = {
    book: "JER", chapter: 30, verse: 11, verse_end: null, bible_version: "UST",
    content_json: JSON.stringify({
      verseObjects: [
        { type: "word", tag: "w", text: "word", occurrence: "1", occurrences: "1" },
        { tag: "x", content: "+ \\xo 30:11 \\xt Isa 2:2", nesting: 1, endTag: "x*" },
      ],
    }),
    plain_text: "word", version: 1, updated_by: null, updated_at: 0,
  };
  const xrefOut = buildUsfm({ book: "JER", bibleVersion: "UST", headers: null, verses: [realXref] });
  assert(xrefOut.includes("\\xt Isa 2:2"), `a genuine \\x cross-reference is preserved`);
}

// --- tsvCell escapes bare \r (and \r\n) instead of leaking it into the TSV ---
{
  const row = (note) => ({
    ref_raw: "1:1", id: "ab12", tags: null, support_reference: null,
    quote: null, occurrence: 1, note,
  });
  const out = buildTnTsv([row("alpha\rbeta"), row("gamma\r\ndelta")]);
  assert(!out.includes("\r"), `no raw carriage returns in TSV output`);
  assert(out.includes("alpha\\nbeta"), `bare \\r escapes to the literal \\n`);
  assert(out.includes("gamma\\ndelta"), `CRLF collapses to one literal \\n`);
}

// --- every export branch carries `-be-` so the DCS gates don't skip it ---
{
  // The DCS workflows gate on contains(head_ref, '-be-') WITH the trailing
  // dash; a suffix-less `LAM-be` made every step `skipped`, which Gitea reports
  // as a green combined status. Machine-only exports get "mechanical".
  assert(buildExportBranch("LAM", []) === "LAM-be-mechanical", `no contributors → {BOOK}-be-mechanical`);
  assert(buildExportBranch("AMO", ["", "  "]) === "AMO-be-mechanical", `sanitized-to-empty usernames → mechanical`);
  assert(buildExportBranch("NUM", ["stephenwunrow"]) === "NUM-be-stephenwunrow", `single contributor unchanged`);
  assert(buildExportBranch("ISA", ["a", "b"]) === "ISA-be-a-b", `multiple contributors joined`);
  for (const b of [buildExportBranch("LAM", []), buildExportBranch("NUM", ["x"])]) {
    assert(b.includes("-be-"), `${b} contains "-be-" (DCS gate literal)`);
  }
}

// --- chapter-scoped export branches use a distinct `-bec-` family ---
{
  assert(buildChapterExportBranch("LAM", []) === "LAM-bec-mechanical", `no contributors → {BOOK}-bec-mechanical`);
  assert(buildChapterExportBranch("AMO", ["", "  "]) === "AMO-bec-mechanical", `sanitized-to-empty usernames → mechanical`);
  assert(buildChapterExportBranch("NUM", ["stephenwunrow"]) === "NUM-bec-stephenwunrow", `single contributor unchanged`);
  assert(buildChapterExportBranch("ISA", ["a", "b"]) === "ISA-bec-a-b", `multiple contributors joined`);
  for (const b of [buildChapterExportBranch("LAM", []), buildChapterExportBranch("NUM", ["x"])]) {
    assert(!b.includes("-be-"), `${b} must NOT contain "-be-" (must not match the nightly/DCS-gate branch family)`);
  }
}

// --- OL-quote occurrence invariant: Hebrew/Greek quote forces Occurrence >= 1 ---
{
  const tn = (quote, occurrence) => ({
    ref_raw: "7:1", id: "vut4", tags: null, support_reference: null,
    quote, occurrence, note: "n",
  });
  // Hebrew quote with null/0 occurrence → coerced to 1.
  const heb = buildTnTsv([tn("הַ⁠תְּשִׁעִ֖י לַ⁠חֹ֥דֶשׁ", 0), tn("פְּנֵ֥י יְהוָֽה", null)]).split("\n");
  assert(heb[1].split("\t")[5] === "1", `Hebrew quote, occurrence 0 → 1`);
  assert(heb[2].split("\t")[5] === "1", `Hebrew quote, occurrence null → 1`);
  // Gateway-Language (English) quote keeps occurrence 0 — invariant doesn't apply.
  const gl = buildTnTsv([tn("the ninth month", 0)]).split("\n");
  assert(gl[1].split("\t")[5] === "0", `GL quote keeps occurrence 0`);
  // A real second-occurrence Hebrew target is left untouched.
  const second = buildTnTsv([tn("יְהוָֽה", 2)]).split("\n");
  assert(second[1].split("\t")[5] === "2", `Hebrew quote, occurrence 2 left as 2`);
  // TWL OrigWords (always OL) gets the same guard.
  const twl = buildTwlTsv([{ ref_raw: "7:1", id: "x", tags: null, orig_words: "יְהוָֽה", occurrence: 0, tw_link: "rc://x" }]).tsv.split("\n");
  assert(twl[1].split("\t")[4] === "1", `TWL OrigWords occurrence 0 → 1`);
}

// --- DCS no-op comparison handles UTF-8 content ---
{
  const originalFetch = globalThis.fetch;
  const config = {
    baseUrl: "https://dcs.example",
    token: "secret",
    owner: "owner",
    repo: "repo",
    branch: "ZEC-be",
  };
  const existing = "Reference\tQuote\tNote\n1:1\tשָׁלוֹם\tשלום עולם\n";
  try {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      const method = init.method ?? "GET";
      // resetExportBranchToMaster (runs first inside commitToDcs): look up the
      // master ref, then force-update the branch ref onto it.
      if (u.includes("/git/refs/heads/master") && method === "GET") {
        return new Response(JSON.stringify({ ref: "refs/heads/master", object: { sha: "master-sha" } }),
          { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/git/refs/heads/") && method === "PATCH") {
        return new Response(JSON.stringify({ ref: "refs/heads/ZEC-be", object: { sha: "master-sha" } }),
          { status: 200, headers: { "Content-Type": "application/json" } });
      }
      // contents API: GET the existing file, PUT/POST to write it.
      if (method === "GET") {
        return new Response(JSON.stringify({
          sha: "existing-sha",
          encoding: "base64",
          content: utf8Base64(existing),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        content: { sha: "new-sha" },
        commit: { sha: "commit-sha" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    // Count only the contents-API calls so the branch-reset preamble doesn't
    // skew the lookup-vs-write assertions.
    const contentCalls = () => calls.filter((c) => c.url.includes("/contents/"));

    const noop = await commitToDcs(config, "tn_ZEC.tsv", existing, "nightly");
    assert(noop.changed === false, `UTF-8 DCS match is a no-op`);
    assert(noop.branchTouched === false, `master match skips the branch entirely`);
    assert(contentCalls().length === 1, `UTF-8 no-op does not send a write request`);
    assert(!calls.some((c) => c.url.includes("/git/refs/")), `master match issues no branch-ref calls`);

    calls.length = 0;
    const changedContent = existing.replace("שלום עולם", "שלום חדש");
    const changed = await commitToDcs(config, "tn_ZEC.tsv", changedContent, "nightly");
    assert(changed.changed === true, `UTF-8 DCS mismatch sends a commit`);
    assert(changed.branchTouched === true, `UTF-8 mismatch ensures the branch`);
    assert(contentCalls().length === 3, `UTF-8 mismatch performs master + branch lookups plus write`);
    const writeCall = contentCalls().find((c) => (c.init.method ?? "GET") !== "GET");
    assert(writeCall && writeCall.init.method === "PUT", `UTF-8 mismatch updates existing file`);
    const body = JSON.parse(String(writeCall.init.body));
    assert(body.content === utf8Base64(changedContent), `UTF-8 commit body is base64 encoded`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- resetExportBranchToMaster is idempotent across 200/404/409/422 ---
// Regression for the ISA-be-deferredreward wedge: a PATCH 409 ("reference
// already exists") used to throw dcs_branch_reset_failed on every retry.
{
  const originalFetch = globalThis.fetch;
  const cfg = { baseUrl: "https://dcs.example", token: "t", owner: "o", repo: "r", branch: "ISA-be-x" };
  const okJson = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const masterRef = () => okJson({ ref: "refs/heads/master", object: { sha: "master-sha" } });
  const writeOk = () => okJson({ content: { sha: "new-sha" }, commit: { sha: "commit-sha" } });

  // Build a fetch mock from per-endpoint handlers. Order matters: the master
  // ref GET and the POST /branches (no trailing slash) are matched before the
  // generic /branches/:name GET.
  const makeFetch = (h) => {
    const calls = [];
    const fn = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      calls.push({ u, m });
      if (u.includes("/git/refs/heads/master") && m === "GET") return masterRef();
      if (u.includes("/git/refs/heads/") && m === "PATCH") return h.patch();
      if (u.includes("/git/refs/heads/") && m === "GET") return (h.getRef ?? notFound)();
      if (u.includes("/git/refs/heads/") && m === "DELETE") return (h.delRef ?? (() => okJson({})))();
      if (u.endsWith("/branches") && m === "POST") return h.postBranch();
      if (u.includes("/branches/") && m === "DELETE") return (h.delBranch ?? (() => okJson({})))();
      if (u.includes("/branches/") && m === "GET") return h.getBranch();
      if (u.includes("/contents/") && m === "GET") return h.getContents();
      if (u.includes("/contents/")) return writeOk(); // PUT/POST commit
      throw new Error(`unexpected ${m} ${u}`);
    };
    return { fn, calls };
  };
  const notFound = () => okJson({ message: "Not Found" }, 404);

  try {
    // (1) PATCH 409 (branch exists) → confirmed via GET, no create, commit proceeds.
    {
      const { fn, calls } = makeFetch({
        patch: () => okJson({ message: "reference already exists" }, 409),
        getBranch: () => okJson({ name: "ISA-be-x" }),
        postBranch: () => { throw new Error("must not POST /branches when it already exists"); },
        getContents: notFound,
      });
      globalThis.fetch = fn;
      const r = await commitToDcs(cfg, "23-ISA.usfm", "data", "msg");
      assert(r.changed === true, `PATCH 409 (exists) → commit proceeds (regression for ISA-be wedge)`);
      assert(calls.some((c) => c.u.includes("/branches/ISA-be-x") && c.m === "GET"), `409 path confirms branch via GET`);
    }

    // (2) PATCH 404 → create from master → visible → POST (new file) commit.
    {
      let posted = false;
      const { fn } = makeFetch({
        patch: notFound,
        getBranch: () => okJson({ name: "ISA-be-x" }),
        postBranch: () => { posted = true; return okJson({ name: "ISA-be-x" }, 201); },
        getContents: notFound,
      });
      globalThis.fetch = fn;
      const r = await commitToDcs(cfg, "23-ISA.usfm", "data", "msg");
      assert(posted, `PATCH 404 → creates the branch from master`);
      assert(r.changed === true, `404 create path commits the new file`);
    }

    // (3) create, then branch invisible on first GET, visible on second (read-after-write lag).
    {
      let getBranchCalls = 0;
      const { fn } = makeFetch({
        patch: notFound,
        getBranch: () => { getBranchCalls++; return getBranchCalls < 2 ? notFound() : okJson({ name: "ISA-be-x" }); },
        postBranch: () => okJson({ name: "ISA-be-x" }, 201),
        getContents: notFound,
      });
      globalThis.fetch = fn;
      const r = await commitToDcs(cfg, "23-ISA.usfm", "data", "msg");
      assert(r.changed === true && getBranchCalls >= 2, `ensureBranchVisible polls past a read-after-write 404`);
    }

    // (4) POST /branches 409 (concurrent create) is benign.
    {
      const { fn } = makeFetch({
        patch: notFound,
        getBranch: () => okJson({ name: "ISA-be-x" }),
        postBranch: () => okJson({ message: "branch already exists" }, 409),
        getContents: notFound,
      });
      globalThis.fetch = fn;
      const r = await commitToDcs(cfg, "23-ISA.usfm", "data", "msg");
      assert(r.changed === true, `POST /branches 409 treated as benign`);
    }

    // (5) branch never becomes visible → throw dcs_branch_not_visible (fail the step, don't commit nowhere).
    {
      const { fn } = makeFetch({
        patch: notFound,
        getBranch: notFound,
        postBranch: () => okJson({ name: "ISA-be-x" }, 201),
        getContents: notFound,
      });
      globalThis.fetch = fn;
      let threw = null;
      try { await commitToDcs(cfg, "23-ISA.usfm", "data", "msg"); } catch (e) { threw = e; }
      assert(threw && String(threw.message).includes("dcs_branch_not_visible"), `invisible branch throws dcs_branch_not_visible`);
    }

    // (6) dangling ref (ref exists, branch 404 — the real ISA-be corruption):
    //     heal by deleting the ref, recreating from master, then committing.
    {
      let refDeleted = false;
      const { fn, calls } = makeFetch({
        patch: () => okJson({ message: "reference already exists" }, 409),
        // Branch only becomes visible once the dangling ref is deleted + recreated.
        getBranch: () => (refDeleted ? okJson({ name: "ISA-be-x" }) : notFound()),
        getRef: () => okJson({ ref: "refs/heads/ISA-be-x", object: { sha: "dangling" } }),
        delRef: () => { refDeleted = true; return okJson({}); },
        // POST /branches fails (ref still there) until the ref is deleted.
        postBranch: () => (refDeleted ? okJson({ name: "ISA-be-x" }, 201) : okJson({ message: "reference already exists" }, 409)),
        getContents: notFound,
      });
      globalThis.fetch = fn;
      const r = await commitToDcs(cfg, "23-ISA.usfm", "data", "msg");
      assert(refDeleted && r.changed === true, `dangling ref healed: delete ref → recreate → commit`);
      assert(calls.some((c) => c.u.includes("/git/refs/heads/ISA-be-x") && c.m === "DELETE"), `heal issues a DELETE on the dangling ref`);
    }

    // (7) content already matches MASTER → no branch is created/reset at all
    //     (untouched pairs used to mint junk -be- branches the token can't delete).
    {
      const mustNotTouchBranch = () => { throw new Error("must not touch the branch when master matches"); };
      const { fn } = makeFetch({
        patch: mustNotTouchBranch,
        getBranch: mustNotTouchBranch,
        postBranch: mustNotTouchBranch,
        getContents: () => okJson({ sha: "master-blob", encoding: "base64", content: utf8Base64("data") }),
      });
      globalThis.fetch = fn;
      const r = await commitToDcs(cfg, "23-ISA.usfm", "data", "msg");
      assert(r.changed === false && r.branchTouched === false, `master match skips branch + commit (no junk branch)`);
      // forceBranch overrides the master pre-check (lingering-open-PR path).
      const { fn: fn2 } = makeFetch({
        patch: () => okJson({ ref: "refs/heads/ISA-be-x", object: { sha: "master-sha" } }),
        getBranch: () => okJson({ name: "ISA-be-x" }),
        postBranch: () => okJson({ name: "ISA-be-x" }, 201),
        getContents: () => okJson({ sha: "master-blob", encoding: "base64", content: utf8Base64("data") }),
      });
      globalThis.fetch = fn2;
      const forced = await commitToDcs(cfg, "23-ISA.usfm", "data", "msg", { forceBranch: true });
      assert(forced.branchTouched === true && forced.changed === false, `forceBranch ensures the branch even on a content match`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- commitToDcs opts.expectedSha: compare-and-swap guard for the
// chapter-scoped export (exportChapterMerge.ts). A caller that merged its
// content against a specific base-file read must not have that write land
// blindly if the branch moved since — this is the "sequential chapter
// exports racing master" fix (see exportWorkflow.ts commitChapterRange).
{
  const originalFetch = globalThis.fetch;
  const cfg = { baseUrl: "https://dcs.example", token: "t", owner: "o", repo: "r", branch: "MRK-be-x" };
  const okJson = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const masterRef = () => okJson({ ref: "refs/heads/master", object: { sha: "master-sha" } });
  try {
    // (a) expectedSha does NOT match the branch file's actual sha → staleBase,
    //     and no write (PUT/POST) is ever issued.
    {
      let wrote = false;
      globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        const m = init.method ?? "GET";
        if (u.includes("/git/refs/heads/master") && m === "GET") return masterRef();
        if (u.includes("/git/refs/heads/") && m === "PATCH") {
          return okJson({ ref: "refs/heads/MRK-be-x", object: { sha: "master-sha" } });
        }
        if (u.includes("/branches/") && m === "GET") return okJson({ name: "MRK-be-x" });
        if (u.includes("/contents/") && m === "GET") {
          // Master pre-check (baseRef) vs. branch lookup (config.branch) —
          // distinguish by the ref query param.
          if (u.includes("ref=master")) {
            return okJson({ sha: "master-blob", encoding: "base64", content: utf8Base64("old master content") });
          }
          return okJson({ sha: "branch-blob-sha", encoding: "base64", content: utf8Base64("branch content") });
        }
        if (u.includes("/contents/")) {
          wrote = true;
          return okJson({ content: { sha: "new-sha" }, commit: { sha: "commit-sha" } });
        }
        throw new Error(`unexpected ${m} ${u}`);
      };
      const r = await commitToDcs(cfg, "42-MRK.tsv", "new merged content", "msg", {
        expectedSha: "sha-the-caller-merged-against",
      });
      assert(r.staleBase === true, "mismatched expectedSha reports staleBase");
      assert(r.changed === false, "staleBase result reports changed:false");
      assert(!wrote, "no PUT/POST is issued when expectedSha doesn't match the branch file's sha");
    }

    // (b) expectedSha matches the branch file's actual sha → the write
    //     proceeds and the PUT body carries that sha (not staleBase).
    {
      let putBody = null;
      globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        const m = init.method ?? "GET";
        if (u.includes("/git/refs/heads/master") && m === "GET") return masterRef();
        if (u.includes("/git/refs/heads/") && m === "PATCH") {
          return okJson({ ref: "refs/heads/MRK-be-x", object: { sha: "master-sha" } });
        }
        if (u.includes("/branches/") && m === "GET") return okJson({ name: "MRK-be-x" });
        if (u.includes("/contents/") && m === "GET") {
          if (u.includes("ref=master")) {
            return okJson({ sha: "master-blob", encoding: "base64", content: utf8Base64("old master content") });
          }
          return okJson({ sha: "branch-blob-sha", encoding: "base64", content: utf8Base64("branch content") });
        }
        if (u.includes("/contents/") && m === "PUT") {
          putBody = JSON.parse(String(init.body));
          return okJson({ content: { sha: "new-sha" }, commit: { sha: "commit-sha" } });
        }
        throw new Error(`unexpected ${m} ${u}`);
      };
      const r = await commitToDcs(cfg, "42-MRK.tsv", "new merged content", "msg", {
        expectedSha: "branch-blob-sha",
      });
      assert(!r.staleBase, "matching expectedSha does not report staleBase");
      assert(r.changed === true, "matching expectedSha proceeds with the commit");
      assert(putBody !== null, "a matching expectedSha issues a PUT");
      assert(putBody.sha === "branch-blob-sha", "PUT body carries the matching expectedSha as the file's sha");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- commitToDcs opts.preserveBranch: never reset a reused chapter-export
// branch onto master (Finding 1 — resetting a branch that already carries an
// earlier chapter run's rows dropped them before the CAS write landed the
// new range). preserveBranch swaps resetExportBranchToMaster for
// ensureExportBranchExists: an existing branch is left exactly where it is
// (no PATCH git/refs/heads/...), and a missing branch is still created from
// master so the first chapter commit has somewhere to land.
{
  const originalFetch = globalThis.fetch;
  const cfg = { baseUrl: "https://dcs.example", token: "t", owner: "o", repo: "r", branch: "ZEC-be-x" };
  const okJson = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  try {
    // (a) branch already exists and its file's blob sha differs from
    //     master's — preserveBranch must not move it: no PATCH git/refs, and
    //     the write proceeds as a PUT against the branch's own sha.
    {
      const calls = [];
      let putBody = null;
      globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        const m = init.method ?? "GET";
        calls.push({ u, m });
        if (u.includes("/git/refs/heads/") && m === "PATCH") {
          throw new Error("preserveBranch must not PATCH git/refs to reset the branch onto master");
        }
        if (u.includes("/branches/") && m === "GET") return okJson({ name: "ZEC-be-x" });
        if (u.includes("/contents/") && m === "GET") {
          if (u.includes("ref=master")) {
            return okJson({ sha: "master-blob", encoding: "base64", content: utf8Base64("master content") });
          }
          return okJson({ sha: "branch-blob-sha", encoding: "base64", content: utf8Base64("branch content (ch13)") });
        }
        if (u.includes("/contents/") && m === "PUT") {
          putBody = JSON.parse(String(init.body));
          return okJson({ content: { sha: "new-sha" }, commit: { sha: "commit-sha" } });
        }
        throw new Error(`unexpected ${m} ${u}`);
      };
      const r = await commitToDcs(cfg, "tn_ZEC.tsv", "branch content (ch13) + ch14 merged", "msg", {
        preserveBranch: true,
        expectedSha: "branch-blob-sha",
      });
      assert(
        !calls.some((c) => c.u.includes("/git/refs/heads/") && c.m === "PATCH"),
        "preserveBranch issues no PATCH git/refs/heads/... request",
      );
      assert(!r.staleBase, "matching expectedSha on the preserved branch does not report staleBase");
      assert(putBody !== null, "preserveBranch still issues a PUT against the existing branch");
      assert(putBody.sha === "branch-blob-sha", "PUT carries the preserved branch's own blob sha");
    }

    // (b) branch does not exist yet — preserveBranch still creates it from
    //     master (via ensureExportBranchExists), but only through POST
    //     /branches, never a PATCH git/refs reset.
    {
      const calls = [];
      let createBody = null;
      let postContentBody = null;
      let branchPolls = 0;
      globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        const m = init.method ?? "GET";
        calls.push({ u, m });
        if (u.includes("/git/refs/heads/") && m === "PATCH") {
          throw new Error("preserveBranch must not PATCH git/refs to reset/create the branch");
        }
        if (u.endsWith("/branches") && m === "POST") {
          createBody = JSON.parse(String(init.body));
          return okJson({});
        }
        if (u.includes("/branches/") && m === "GET") {
          branchPolls++;
          // Missing before the create, visible after it.
          return branchPolls === 1 ? okJson({}, 404) : okJson({ name: "ZEC-be-x" });
        }
        if (u.includes("/contents/") && m === "GET") {
          // No file at master or on the freshly-created branch — first-ever
          // chapter commit for this book.
          return okJson({}, 404);
        }
        if (u.includes("/contents/") && m === "POST") {
          postContentBody = JSON.parse(String(init.body));
          return okJson({ content: { sha: "new-sha" }, commit: { sha: "commit-sha" } });
        }
        throw new Error(`unexpected ${m} ${u}`);
      };
      const r = await commitToDcs(cfg, "tn_ZEC.tsv", "ch14 content", "msg", {
        preserveBranch: true,
        expectedSha: null,
      });
      assert(
        calls.some((c) => c.u.endsWith("/branches") && c.m === "POST"),
        "a missing branch is created via POST /branches",
      );
      assert(
        !calls.some((c) => c.u.includes("/git/refs/heads/") && c.m === "PATCH"),
        "creating the missing branch issues no PATCH git/refs/heads/... request",
      );
      assert(createBody?.new_branch_name === "ZEC-be-x", "branch is created with the configured branch name");
      assert(!r.staleBase, "expectedSha:null matches the new file's absence on the fresh branch");
      assert(postContentBody !== null, "the commit itself is a POST (new file)");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- commitToDcs opts.preserveBranch skips the master-equality short-circuit
// (Finding I). A reused chapter-export branch (reuseChapterBranch) can carry
// a DIFFERENT blob than master even when THIS run's rendered content happens
// to equal master byte-for-byte (e.g. a stale prior range never got its own
// re-export). The plain master short-circuit above would report
// branchTouched:false for that case, and exportOne reads branchTouched:false
// as "nothing to export" — closing the branch's still-open PR as unchanged
// while the wrong (stale) blob keeps sitting on the branch. With
// preserveBranch, the master compare must be skipped entirely so the call
// falls through to the branch-file lookup and PUTs the branch, exactly as
// any other content mismatch would.
{
  const originalFetch = globalThis.fetch;
  const cfg = { baseUrl: "https://dcs.example", token: "t", owner: "o", repo: "r", branch: "ZEC-bec-x" };
  const okJson = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  try {
    let putBody = null;
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      calls.push({ u, m });
      if (u.includes("/git/refs/heads/") && m === "PATCH") {
        throw new Error("preserveBranch must not PATCH git/refs to reset the branch onto master");
      }
      if (u.includes("/branches/") && m === "GET") return okJson({ name: "ZEC-bec-x" });
      if (u.includes("/contents/") && m === "GET") {
        if (u.includes("ref=master")) {
          // Only reachable if the (skipped) master short-circuit still ran.
          return okJson({ sha: "master-blob", encoding: "base64", content: utf8Base64("shared content") });
        }
        return okJson({ sha: "branch-blob-sha", encoding: "base64", content: utf8Base64("stale branch content") });
      }
      if (u.includes("/contents/") && m === "PUT") {
        putBody = JSON.parse(String(init.body));
        return okJson({ content: { sha: "new-sha" }, commit: { sha: "commit-sha" } });
      }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const r = await commitToDcs(cfg, "tn_ZEC.tsv", "shared content", "msg", {
      preserveBranch: true,
      expectedSha: "branch-blob-sha",
    });
    assert(
      !calls.some((c) => c.u.includes("/contents/") && c.u.includes("ref=master") && c.m === "GET"),
      "preserveBranch never fetches master's file for the equality short-circuit",
    );
    assert(
      !calls.some((c) => c.u.includes("/git/refs/heads/") && c.m === "PATCH"),
      "preserveBranch issues no PATCH git/refs/heads/... request",
    );
    assert(putBody !== null, "content equal to master but different from the branch file still issues a PUT to the branch");
    assert(putBody.sha === "branch-blob-sha", "PUT carries the branch's own (stale) blob sha");
    assert(!r.staleBase, "matching expectedSha does not report staleBase");
    assert(r.branchTouched === true, "the branch is reported touched, not silently short-circuited as unchanged");
    assert(r.changed === true, "the branch write is reported as a real change");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- corrupt content_json fails export instead of emitting a partial book ---
{
  const bad = {
    book: "ZEC",
    chapter: 1,
    verse: 1,
    verse_end: null,
    bible_version: "ULT",
    content_json: "{not valid json",
    plain_text: null,
    version: 4,
    updated_by: null,
    updated_at: 0,
  };
  try {
    buildUsfm({ book: "ZEC", bibleVersion: "ULT", headers: null, verses: [bad] });
    assert(false, `corrupt content_json throws`);
  } catch (err) {
    assert(err instanceof CorruptContentJsonError, `corrupt content_json throws typed error`);
    assert(err.context.book === "ZEC", `corrupt content_json error includes book`);
    assert(err.context.version === 4, `corrupt content_json error includes row version`);
  }
}

// --- ensureDcsPr: exact base/head lookup; reuse open PR; 409 + 422 benign ---
// The lookup is GET /pulls/{base}/{head} (not the paged /pulls?state=open list,
// which caps at 50 and let existing PRs fall off page 1 → nightly 409 loop).
{
  const originalFetch = globalThis.fetch;
  const cfg = { baseUrl: "https://dcs.example", token: "t", owner: "o", repo: "r", branch: "ZEC-be-x" };
  const okJson = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const isLookup = (u, m) => u.includes("/pulls/master/ZEC-be-x") && m === "GET";
  try {
    // An open PR already exists for this base/head → reuse it, never POST.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ number: 42, state: "open" });
      throw new Error(`unexpected ${m} ${u}`);
    };
    const r1 = await ensureDcsPr(cfg, "t", "b");
    assert(r1.number === 42 && !r1.created && r1.reason === "existing", `ensureDcsPr reuses an open PR via exact lookup`);

    // Lookup returns a CLOSED PR (the endpoint doesn't filter by state) and
    // the paged fallback finds no open PR for this head either → create a
    // fresh one.
    let posted = false;
    const isList = (u, m) => u.includes("/pulls?state=open") && m === "GET";
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ number: 41, state: "closed" });
      if (isList(u, m)) return okJson([]);
      if (u.endsWith("/pulls") && m === "POST") { posted = true; return okJson({ number: 99 }, 201); }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const r2 = await ensureDcsPr(cfg, "t", "b");
    assert(posted && r2.number === 99 && r2.created && r2.reason === "created", `closed PR with no open match anywhere is not reused; a new one is created`);

    // No PR at all (404) and no open PR in the paged fallback → create one.
    posted = false;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) return okJson([]);
      if (u.endsWith("/pulls") && m === "POST") { posted = true; return okJson({ number: 100 }, 201); }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const r3 = await ensureDcsPr(cfg, "t", "b");
    assert(posted && r3.number === 100 && r3.created && r3.reason === "created", `ensureDcsPr creates a PR when none exists`);

    // Create 409 — DCS's "PR already exists" (ErrPullRequestAlreadyExists) →
    // re-lookup and return the existing PR instead of swallowing it forever.
    let lookups = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) {
        lookups++;
        return lookups === 1 ? okJson({ message: "Not Found" }, 404) : okJson({ number: 7, state: "open" });
      }
      if (isList(u, m)) return okJson([]);
      if (u.endsWith("/pulls") && m === "POST") return okJson({ message: "pull request already exists" }, 409);
      throw new Error(`unexpected ${m} ${u}`);
    };
    const r4 = await ensureDcsPr(cfg, "t", "b");
    assert(r4.number === 7 && !r4.created && r4.reason === "raced", `create 409 (already exists) re-looks-up the existing PR`);

    // Create returns 422 (no commits between) and no racing PR → benign no_diff.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) return okJson([]);
      if (u.endsWith("/pulls") && m === "POST") return okJson({ message: "no commits between" }, 422);
      throw new Error(`unexpected ${m} ${u}`);
    };
    const r5 = await ensureDcsPr(cfg, "t", "b");
    assert(!r5.created && r5.reason === "no_diff", `ensureDcsPr treats 422 as a benign no-op`);

    // Head == base is a guarded no-op (no network at all).
    const r6 = await ensureDcsPr({ ...cfg, branch: "master" }, "t", "b");
    assert(!r6.created && r6.reason === "head_equals_base", `ensureDcsPr skips when head == base`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- findDcsOpenPr: paged fallback when the exact lookup misses an open PR ---
// Regression coverage for the DAN-be-justplainjane47 bug: the exact lookup
// returns the OLDEST PR for a base/head pair regardless of state, so a closed
// PR can shadow a real open one. door43 had 6 PRs for that head (7347, 7351,
// 7357, 7365, 7375, 7382); the exact lookup returned closed #7347 while #7382
// was open.
{
  const originalFetch = globalThis.fetch;
  const cfg = { baseUrl: "https://dcs.example", token: "t", owner: "o", repo: "r", branch: "DAN-be-justplainjane47" };
  const okJson = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const isLookup = (u, m) => u.includes("/pulls/master/DAN-be-justplainjane47") && m === "GET";
  const isList = (u, m) => u.includes("/pulls?state=open") && m === "GET";
  const pageOf = (u) => Number(new URL(u).searchParams.get("page"));
  try {
    // Exact lookup returns an OPEN PR → its number is returned, and the
    // paged fallback is never called.
    let listCalled = false;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ number: 42, state: "open" });
      if (isList(u, m)) { listCalled = true; return okJson([]); }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const found1 = await findDcsOpenPr(cfg);
    assert(found1 === 42 && !listCalled, `open PR from the exact lookup is returned without ever calling the paged fallback`);

    // DAN regression: exact lookup returns a CLOSED PR (the oldest for this
    // head), but an open PR for the same head exists in the paged fallback.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ number: 7347, state: "closed" });
      if (isList(u, m)) {
        // The list endpoint is itself queried with ?state=open, so every
        // item it returns is already open — the only filtering left to do
        // client-side is matching the head/base refs (and same-repo head).
        return okJson([
          { number: 6501, state: "open", head: { ref: "OTHER-be-someone", repo: { full_name: "o/r" } }, base: { ref: "master" } },
          { number: 7382, state: "open", head: { ref: "DAN-be-justplainjane47", repo: { full_name: "o/r" } }, base: { ref: "master" } },
        ]);
      }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const found2 = await findDcsOpenPr(cfg);
    assert(found2 === 7382, `DAN regression: a closed PR from the exact lookup no longer shadows the real open PR found via paged fallback`);

    // Exact lookup 404s and no open PR matches anywhere → null.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) return okJson([]);
      throw new Error(`unexpected ${m} ${u}`);
    };
    const found3 = await findDcsOpenPr(cfg);
    assert(found3 === null, `404 exact lookup with no open PR anywhere returns null`);

    // Open PR for this head sits on page 2 of the paged fallback.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) {
        const page = pageOf(u);
        if (page === 1) {
          const items = Array.from({ length: 50 }, (_, i) => ({
            number: i + 1,
            state: "open",
            head: { ref: `other-branch-${i}`, repo: { full_name: "o/r" } },
            base: { ref: "master" },
          }));
          return okJson(items);
        }
        if (page === 2) {
          return okJson([{ number: 999, state: "open", head: { ref: "DAN-be-justplainjane47", repo: { full_name: "o/r" } }, base: { ref: "master" } }]);
        }
        return okJson([]);
      }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const found4 = await findDcsOpenPr(cfg);
    assert(found4 === 999, `an open PR on page 2 of the paged fallback is still found`);

    // Server clamps the page size below the requested `limit` (Gitea's
    // MaxResponseItems) — page 1 returns only 30 of the requested 50, well
    // short of `limit`, yet an open PR still exists on page 2. This is the
    // finding-1 regression case: it fails against `if (items.length < limit)
    // break`, which would have stopped after page 1 and never found it.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) {
        const page = pageOf(u);
        if (page === 1) {
          const items = Array.from({ length: 30 }, (_, i) => ({
            number: i + 1,
            state: "open",
            head: { ref: `other-branch-${i}`, repo: { full_name: "o/r" } },
            base: { ref: "master" },
          }));
          return okJson(items);
        }
        if (page === 2) {
          return okJson([{ number: 4242, state: "open", head: { ref: "DAN-be-justplainjane47", repo: { full_name: "o/r" } }, base: { ref: "master" } }]);
        }
        return okJson([]);
      }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const found5 = await findDcsOpenPr(cfg);
    assert(found5 === 4242, `a clamped page 1 (fewer items than the requested limit) still continues to page 2 and finds the open PR`);

    // State guard (parity with the fast path): the list endpoint is queried
    // with `?state=open`, so this should never happen in practice, but a
    // matching head/base/repo item whose own `state` field isn't "open"
    // (e.g. a stale/inconsistent server response) must NOT be matched.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) {
        return okJson([
          { number: 8888, state: "closed", head: { ref: "DAN-be-justplainjane47", repo: { full_name: "o/r" } }, base: { ref: "master" } },
        ]);
      }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const foundStateGuard = await findDcsOpenPr(cfg);
    assert(foundStateGuard === null, `state guard: a matching head/base/repo item whose own state isn't "open" is not matched`);

    // Fork-head guard: a PR with the same head.ref and base.ref, but whose
    // head repo is a contributor's fork (not this repo), must NOT match —
    // matching it would return a stranger's PR number and cause writes
    // (close/update/rebase) against someone else's pull request.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) {
        return okJson([
          { number: 5555, state: "open", head: { ref: "DAN-be-justplainjane47", repo: { full_name: "someforker/r" } }, base: { ref: "master" } },
        ]);
      }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const found6 = await findDcsOpenPr(cfg);
    assert(found6 === null, `same-repo guard: a fork-head PR with a matching head.ref/base.ref is not matched`);

    // Case-only owner/repo casing regression: DCS returns canonical casing in
    // full_name ("O/R") even though our config is lowercase ("o"/"r") — this
    // must still match the same-repo guard, not be mistaken for a fork.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) {
        return okJson([
          { number: 6600, state: "open", head: { ref: "DAN-be-justplainjane47", repo: { full_name: "O/R" } }, base: { ref: "master" } },
        ]);
      }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const found6b = await findDcsOpenPr(cfg);
    assert(found6b === 6600, `same-repo guard is case-insensitive: canonical-cased full_name from DCS still matches`);

    // A non-OK list response throws rather than silently returning null —
    // a silent null is exactly what hid the DAN bug for a week.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) return new Response("server error", { status: 500 });
      throw new Error(`unexpected ${m} ${u}`);
    };
    let threw = false;
    try {
      await findDcsOpenPr(cfg);
    } catch (e) {
      threw = /dcs_pull_list_failed/.test(String(e.message));
    }
    assert(threw, `a non-OK paged list response throws dcs_pull_list_failed instead of returning null`);

    // A 200 list response whose body is not an array (e.g. a Gitea error
    // object shaped like the pulls list, or a gateway page) throws a labeled
    // error rather than a bare TypeError from items.find(...).
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) return okJson({ message: "not actually a list" });
      throw new Error(`unexpected ${m} ${u}`);
    };
    let threwNonArray = false;
    try {
      await findDcsOpenPr(cfg);
    } catch (e) {
      threwNonArray = /dcs_pull_list_failed/.test(String(e.message));
    }
    assert(threwNonArray, `a non-array 200 list body throws a labeled dcs_pull_list_failed error`);

    // Empty first page terminates the scan immediately — the `if
    // (items.length === 0) break` line has the same return value with or
    // without the break (both paths fall through to `return null`), so only
    // a request-count assertion can pin that it actually breaks rather than
    // looping to maxPages.
    let listCalls1 = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) { listCalls1++; return okJson([]); }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const found7 = await findDcsOpenPr(cfg);
    assert(found7 === null && listCalls1 === 1, `an empty first page terminates the scan after exactly one list call`);

    // maxPages backstop: every page is non-empty but never matches, so the
    // loop must run all 20 pages (not loop forever, not stop early).
    let listCalls2 = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (isLookup(u, m)) return okJson({ message: "Not Found" }, 404);
      if (isList(u, m)) {
        listCalls2++;
        return okJson([
          { number: 1, state: "open", head: { ref: "never-matches", repo: { full_name: "o/r" } }, base: { ref: "master" } },
        ]);
      }
      throw new Error(`unexpected ${m} ${u}`);
    };
    const found8 = await findDcsOpenPr(cfg);
    assert(found8 === null && listCalls2 === 20, `a never-matching, never-empty page set runs all 20 pages before giving up`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- updateDcsPrBranch: 200 → ok; conflict statuses return, never throw ---
{
  const originalFetch = globalThis.fetch;
  const cfg = { baseUrl: "https://dcs.example", token: "t", owner: "o", repo: "r" };
  try {
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      if (u.endsWith("/pulls/5/update") && m === "POST") return new Response("", { status: 200 });
      throw new Error(`unexpected ${m} ${u}`);
    };
    const ok = await updateDcsPrBranch(cfg, 5);
    assert(ok.ok === true && ok.status === 200, `updateDcsPrBranch 200 → ok`);

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: "merge failed because of conflict" }), { status: 409 });
    const conflict = await updateDcsPrBranch(cfg, 5);
    assert(conflict.ok === false && conflict.status === 409 && conflict.detail.includes("conflict"),
      `updateDcsPrBranch 409 (merge conflict) reports without throwing`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- exportTsvShrinkRefused: truncation backstop (the twl_PSA clobber) ---
{
  // The actual incident: D1 held 4880 of master's 7776 rows → must refuse.
  assert(exportTsvShrinkRefused(4880, 7776) === true, `PSA 4880-of-7776 (37% loss) is refused`);
  // Ordinary editorial cleanup (Beth removed ~61 of 7776, <1%) must pass.
  assert(exportTsvShrinkRefused(7715, 7776) === false, `small cleanup (-61) is allowed`);
  // Growth (D1 ahead of master, e.g. added notes) is never a shrink.
  assert(exportTsvShrinkRefused(850, 742) === false, `growth (more rows than master) allowed`);
  // Equal is allowed.
  assert(exportTsvShrinkRefused(500, 500) === false, `no change allowed`);
  // Tiny absolute loss on a small book is below the floor even past 5%.
  assert(exportTsvShrinkRefused(280, 300) === false, `20-row loss under the 25-row floor allowed`);
  // Just over both floors (>25 rows AND >5%) is refused.
  assert(exportTsvShrinkRefused(440, 500) === true, `60-of-500 loss (12%) refused`);
  // Empty master can't be shrunk (nothing to protect) — fresh book.
  assert(exportTsvShrinkRefused(0, 0) === false, `empty master never refuses`);
  // A render to zero rows against a populated master is the strongest signal.
  assert(exportTsvShrinkRefused(0, 4000) === true, `render-to-empty against populated master refused`);
}

// --- #934: the guard counts master IDs missing from the render, not net rows ---
// A render that loses 200 master notes but adds 200 notes master never had has
// the same row count; the old net-count check passed it and master lost 200 notes.
{
  const HDR = "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote";
  const id = (p, i) => p + String(i).padStart(3, "0");
  const tsv = (ids) => [HDR, ...ids.map((x) => `1:1\t${x}\t\t\t\t0\tnote`)].join("\n") + "\n";
  const masterIds = Array.from({ length: 1000 }, (_, i) => id("a", i));
  const master = tsv(masterIds);

  // Swap: drop 200 master IDs, add 200 new ones. Same row count.
  const swap = tsv([...masterIds.slice(200), ...Array.from({ length: 200 }, (_, i) => id("n", i))]);
  assert(missingMasterIdCount(master, swap) === 200, `swap: 200 master IDs missing from the render`);
  assert(exportTsvShrinkRefused(1000, 1000, missingMasterIdCount(master, swap)) === true,
    `swap of 200 of 1000 master IDs (same row count) is refused`);

  // Only additions: every master ID still present.
  const grown = tsv([...masterIds, ...Array.from({ length: 300 }, (_, i) => id("n", i))]);
  assert(missingMasterIdCount(master, grown) === 0, `additions only: no master ID missing`);
  assert(exportTsvShrinkRefused(1300, 1000, 0) === false, `additions only pass`);

  // A small swap under the 25-row floor still passes.
  const small = tsv([...masterIds.slice(20), ...Array.from({ length: 20 }, (_, i) => id("n", i))]);
  assert(exportTsvShrinkRefused(1000, 1000, missingMasterIdCount(master, small)) === false,
    `swap of 20 IDs (under the 25-row floor) passes`);

  // The net-count floor still holds when master repeats an ID: 40 duplicate
  // rows collapsed to one each leave no ID missing but still drop 40 rows of 500.
  const dupMaster = tsv([...masterIds.slice(0, 460), ...masterIds.slice(0, 40)]);
  const dedup = tsv(masterIds.slice(0, 460));
  assert(missingMasterIdCount(dupMaster, dedup) === 0, `duplicate master IDs: none missing by ID`);
  assert(exportTsvShrinkRefused(460, 500, 0) === true, `net loss of 40 of 500 rows still refused`);

  // tQ and tWL files carry ID in the second column too, under their own headers.
  const tq = (ids) => ["Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse", ...ids.map((x) => `1:1\t${x}\t\t\t\tq\tr`)].join("\n") + "\n";
  assert(missingMasterIdCount(tq(masterIds), tq(masterIds.slice(100))) === 100, `tq: missing IDs counted`);
  const twl = (ids) => ["Reference\tID\tTags\tOrigWords\tOccurrence\tTWLink", ...ids.map((x) => `1:1\t${x}\t\t\t1\trc://x`)].join("\n") + "\n";
  assert(missingMasterIdCount("﻿" + twl(masterIds), twl(masterIds.slice(100)).replace(/\n/g, "\r\n")) === 100,
    `twl: missing IDs counted (BOM, CRLF)`);

  // No ID column on either side: nothing to compare by ID, so the count rule alone decides.
  assert(missingMasterIdCount("A\tB\nx\ty\n", "A\tB\n") === 0, `no ID column: 0 (count rule decides)`);
}

// --- masterFetchGate: first-export bootstrap vs fail-closed (#235) ---
// A clean 404 on the destination master file means "file doesn't exist yet"
// (new org / newly imported book into skeleton repos) — the shrink guards may
// allow the commit. Every other failure must stay fail-closed as unreadable.
{
  const gate = masterFetchGate;
  assert(gate({ status: 404, text: null }).kind === "bootstrap", `404 → bootstrap (first export allowed)`);
  assert(gate({ status: 200, text: "a\tb\nc\td" }).kind === "content", `200 with body → content`);
  assert(gate({ status: 200, text: "a\tb\nc\td" }).text === "a\tb\nc\td", `content carries the body through`);
  assert(gate({ status: 401, text: null }).kind === "unreadable", `401 (bad token) stays fail-closed`);
  assert(gate({ status: 403, text: null }).kind === "unreadable", `403 stays fail-closed`);
  assert(gate({ status: 500, text: null }).kind === "unreadable", `500 stays fail-closed`);
  assert(gate({ status: 0, text: null }).kind === "unreadable", `network error (status 0) stays fail-closed`);
  // fetchTextWithStatus reports a truncated read as {status:200, text:null} —
  // that must NOT look like content or bootstrap.
  assert(gate({ status: 200, text: null }).kind === "unreadable", `truncated 200 stays fail-closed`);
  // Self-defense: an error status carrying an error BODY (proxy/maintenance
  // page) must never be compared against the render as if it were master.
  assert(gate({ status: 500, text: "<html>maintenance</html>" }).kind === "unreadable", `500 with body stays fail-closed`);
}

// --- usfmAlignmentShrinkRefused: ULT/UST verse alignment backstop ---
// The 1CH 4:21 / NUM 24 signature — a verse loses \zaln milestones on words the
// translator never touched. The export must refuse to ship that to master. This
// now reuses analyzeAlignmentDelta (the SAME analyzer as the write-time guard):
// it REFUSES on a word that survives the edit (matched by surface) but lost its
// \zaln source (`reason === "lost"`) — REGARDLESS of whether the verse's plain
// text also changed — and does NOT refuse on a re-pointed source on an unchanged
// word (`reason === "changed_source"`, the legitimate re-alignment signature).
{
  // One aligned token: \zaln-s ...\* \w word\w* \zaln-e\*. The explicit
  // \zaln-e\* close keeps each milestone a sibling span (usfm-js NESTS
  // consecutive open milestones with no close, which would keep a word "aligned"
  // under an ancestor even after dropping its own \zaln). dealignIdx emits a
  // bare \w (no \zaln) for that word — the de-alignment under test. strongs lets
  // a test override the per-word x-strong/x-content so a word can keep its
  // surface text while its alignment source is re-pointed (changed_source).
  const verse = (book, ch, v, words, dealignIdx = -1, strongs = null) =>
    `\\id ${book}\n\\c ${ch}\n\\p\n\\v ${v} ` +
    words
      .map((word, i) => {
        if (i === dealignIdx) return `\\w ${word}|x-occurrence="1" x-occurrences="1"\\w*`;
        const strong = strongs ? strongs[i] : `H${100 + i}`;
        return `\\zaln-s |x-strong="${strong}" x-content="${word}"\\*\\w ${word}|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*`;
      })
      .join(" ") +
    "\n";

  const master = verse("1CH", 4, 21, ["Lekah", "and", "Shelah"]);

  // (1) INCIDENT regression: the verse's TEXT changed (Lekah→Lecah, a genuine
  // edit) AND an UNTOUCHED neighbor (Shelah) lost its \zaln source. The OLD
  // count-based, text-exempt code wrongly ALLOWED this — the plain-text change
  // exempted exactly the verse that also carried collateral loss. The
  // word-level analyzer matches Shelah in both by surface and sees its source
  // is gone → `lost` → REFUSE.
  const incident = verse("1CH", 4, 21, ["Lecah", "and", "Shelah"], 2);
  const r1 = usfmAlignmentShrinkRefused(incident, master);
  assert(r1.refused === true, `INCIDENT: text edit + collateral loss on an untouched word is refused`);
  assert(r1.offenders.length === 1 && r1.offenders[0].ref === "4:21", `offender is 4:21`);
  // The offender names the de-aligned word (Shelah) rather than a whole-verse count.
  assert(
    JSON.stringify(r1.offenders[0].lostWords) === JSON.stringify(["Shelah"]),
    `offender names the de-aligned word "Shelah"`,
  );

  // (1b) Pure collateral loss, NO text change (the classic NUM 24 shape) → REFUSE.
  const pureLoss = verse("1CH", 4, 21, ["Lekah", "and", "Shelah"], 1);
  const r1b = usfmAlignmentShrinkRefused(pureLoss, master);
  assert(r1b.refused === true, `de-alignment on an otherwise-unchanged verse is refused`);

  // (2) Identical render → allowed.
  const r2 = usfmAlignmentShrinkRefused(master, master);
  assert(r2.refused === false, `identical render is allowed`);

  // (3) Legitimate text rewrite where the ONLY de-aligned word is the one that
  // CHANGED ("and"→"or", and the new word "or" is unaligned). No surviving word
  // lost its source → no `lost` → ALLOWED.
  const rewritten = verse("1CH", 4, 21, ["Lekah", "or", "Shelah"], 1);
  const r3 = usfmAlignmentShrinkRefused(rewritten, master);
  assert(r3.refused === false, `a real text change with no collateral lost word is allowed`);

  // (3b) Legitimate RE-ALIGNMENT: every word's surface text is UNCHANGED, every
  // word stays aligned, but a word's \zaln source is RE-POINTED (changed_source).
  // This is the aligner-panel signature — must NOT be over-blocked.
  const repointed = verse("1CH", 4, 21, ["Lekah", "and", "Shelah"], -1, ["H100", "H999", "H102"]);
  const r3b = usfmAlignmentShrinkRefused(repointed, master);
  assert(r3b.refused === false, `a re-pointed source on an unchanged word (changed_source) is NOT over-blocked`);

  // (4) Render ADDS alignment (more aligned words) → never a refusal.
  const r4 = usfmAlignmentShrinkRefused(master, verse("1CH", 4, 21, ["Lekah", "and", "Shelah"], 1));
  assert(r4.refused === false, `growth in aligned words is not a refusal`);

  // (5) Verse only on master (removed in render) → ignored (content change).
  const masterTwoVerses = master + verse("1CH", 4, 22, ["who", "ruled"]);
  const r5 = usfmAlignmentShrinkRefused(master, masterTwoVerses);
  assert(r5.refused === false, `a verse removed entirely is not flagged as alignment loss`);

  // (5b) Verse ADDED in render (only on render side) → skipped, not a loss.
  const r5b = usfmAlignmentShrinkRefused(masterTwoVerses, master);
  assert(r5b.refused === false, `a verse added in the render is not flagged`);

  // (6) Empty master → nothing to shrink.
  const r6 = usfmAlignmentShrinkRefused(master, "");
  assert(r6.refused === false, `empty master never refuses`);

  // (7) Multiple words de-aligned in one verse → offender lists each lost word,
  // in document order. The alert string (assembled in exportWorkflow.ts) caps
  // the named words at 3 and appends "(+N more)" so the banner stays short while
  // still naming WHICH words to re-align — the point of this refinement.
  const big = ["the", "father", "of", "Bethrapha", "and", "Paseah"];
  const bigMaster = verse("1CH", 4, 21, big);
  // De-align the first three words (indices 0,1,2): "the","father","of".
  const bigRender = verse("1CH", 4, 21, big)
    .replace(/\\zaln-s \|x-strong="H100" x-content="the"\\\*/, "")
    .replace(/\\zaln-s \|x-strong="H101" x-content="father"\\\*/, "")
    .replace(/\\zaln-s \|x-strong="H102" x-content="of"\\\*/, "");
  const r7 = usfmAlignmentShrinkRefused(bigRender, bigMaster);
  assert(r7.refused === true, `multi-word de-alignment is refused`);
  assert(
    JSON.stringify(r7.offenders[0].lostWords) === JSON.stringify(["the", "father", "of"]),
    `offender lists every lost word in document order`,
  );
  // Mirror of the exportWorkflow.ts alert-detail builder (cap 3 + "(+N more)").
  const fmtOffender = (o) => {
    const shown = o.lostWords.slice(0, 3).map((w) => `"${w}"`).join(",");
    const extra = o.lostWords.length - 3;
    return `${o.ref}: lost alignment on ${shown}${extra > 0 ? ` (+${extra} more)` : ""}`;
  };
  assert(
    fmtOffender(r7.offenders[0]) === `4:21: lost alignment on "the","father","of"`,
    `alert names up to 3 lost words (no "+N more" at exactly 3)`,
  );
  // Synthetic offender with 29 lost words → "(+26 more)" (the task's example).
  const manyLost = { ref: "4:21", lostWords: ["the", "father", "of", ...Array(26).fill("x") ] };
  assert(
    fmtOffender(manyLost) === `4:21: lost alignment on "the","father","of" (+26 more)`,
    `alert caps at 3 and appends "(+26 more)"`,
  );

  // (8) FAIL-CLOSED on a broken render. usfm.toJSON does not throw on a
  // malformed USFM *string* — an empty/garbled render parses to ZERO verses.
  // Without the guard, every master verse is skipped (absent from render) and
  // the corrupt render ships, deleting all alignment. Must REFUSE.
  const r8empty = usfmAlignmentShrinkRefused("", master);
  assert(r8empty.refused === true, `an empty render against an aligned master is refused (fail closed)`);
  assert(r8empty.offenders.length === 1 && r8empty.offenders[0].ref === "*", `empty-render offender is the whole-render sentinel "*"`);

  const r8garbage = usfmAlignmentShrinkRefused("not usfm at all {[}]", master);
  assert(r8garbage.refused === true, `a garbled render that parses to zero verses is refused`);

  // (8b) An empty render against an EMPTY master has nothing to lose → allowed
  // (fresh book / no aligned baseline). The fail-closed gate is keyed on the
  // master actually having aligned verses.
  const r8freshboth = usfmAlignmentShrinkRefused("", "");
  assert(r8freshboth.refused === false, `empty render + empty master never refuses`);

  // (8c) Master fetched but UNPARSEABLE (usfm.toJSON throws — reachable today
  // only via non-string input, but the trap must stay closed). The ship
  // decision stays refused:false (loss unprovable), but the result must carry
  // masterUnparseable so the workflow maps it to its own detail
  // ("master_unparseable") instead of "ok" — an absent measurement must never
  // read as "measured clean".
  const r8masterNull = usfmAlignmentShrinkRefused(master, null);
  assert(r8masterNull.refused === false, `unparseable master: ship decision stays refused:false`);
  assert(
    r8masterNull.masterUnparseable === true,
    `unparseable master: flagged masterUnparseable so it can never map to detail:"ok"`,
  );
  // A normally-compared clean run must NOT carry the flag — the only path
  // allowed to report a clean measurement.
  assert(r2.masterUnparseable === undefined, `a real clean comparison carries no masterUnparseable flag`);

  // (9) TOTAL WIPE of a single verse. The render still PARSES and still contains
  // the verse (so neither the zero-verse fail-closed above nor the "absent from
  // render → skip" rule applies) — but the verse body is flat text: every \zaln
  // and every \w gone. This is the ZEC 1:8 signature at export scale. It used to
  // slip through: analyzeAlignmentDelta reported zero losses because it only
  // scored words that SURVIVE, and here none do. Must REFUSE, and must name the
  // words so the alert is actionable.
  const flattened = `\\id 1CH\n\\c 4\n\\p\n\\v 21 Lekah and Shelah\n`;
  const r9 = usfmAlignmentShrinkRefused(flattened, master);
  assert(r9.refused === true, `a verse flattened to plain text in the render is refused`);
  assert(r9.offenders.length === 1 && r9.offenders[0].ref === "4:21", `wipe offender is 4:21`);
  assert(
    JSON.stringify(r9.offenders[0].lostWords) === JSON.stringify(["Lekah", "and", "Shelah"]),
    `wipe offender names every annihilated word`,
  );

  // (9b) A verse emptied of body text entirely (\v with no content) is the same
  // class of loss, not a legitimate deletion — the verse is still present.
  const emptiedVerse = `\\id 1CH\n\\c 4\n\\p\n\\v 21\n`;
  const r9b = usfmAlignmentShrinkRefused(emptiedVerse, master);
  assert(r9b.refused === true, `a verse emptied of all content is refused`);
}

// --- recreateExportBranchFromMaster: delete + recreate off master ---
// Recovers a drifted export branch whose PR conflicted. Needs branch-delete
// (admin token); 403 → rebuilt:false WITHOUT throwing so the caller alerts.
{
  const originalFetch = globalThis.fetch;
  const cfg = { baseUrl: "https://dcs.example", token: "admin", owner: "o", repo: "r", branch: "ISA-be-x" };
  const okJson = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

  // Per-endpoint mock: DELETE /branches/:name, POST /branches (recreate),
  // GET /branches/:name (ensureBranchVisible poll).
  const makeFetch = (h) => {
    const calls = [];
    const fn = async (url, init = {}) => {
      const u = String(url);
      const m = init.method ?? "GET";
      calls.push({ u, m });
      if (u.endsWith("/branches") && m === "POST") return (h.postBranch ?? (() => okJson({ name: cfg.branch })))();
      if (u.includes("/branches/") && m === "DELETE") return h.delBranch();
      if (u.includes("/branches/") && m === "GET") return (h.getBranch ?? (() => okJson({ name: cfg.branch })))();
      throw new Error(`unexpected ${m} ${u}`);
    };
    return { fn, calls };
  };

  try {
    // (1) Happy path: delete 200 → recreate → visible → rebuilt.
    {
      const { fn, calls } = makeFetch({ delBranch: () => okJson({}) });
      globalThis.fetch = fn;
      const r = await recreateExportBranchFromMaster(cfg);
      assert(r.rebuilt === true && r.detail === "rebuilt", `delete 200 → rebuilt`);
      assert(calls.some((c) => c.m === "DELETE"), `issues a branch DELETE`);
      assert(calls.some((c) => c.u.endsWith("/branches") && c.m === "POST"), `recreates the branch from master`);
    }

    // (2) Forbidden delete (service token lacks branch-delete): rebuilt:false,
    // detail surfaces the status, and we do NOT recreate.
    {
      const { fn, calls } = makeFetch({
        delBranch: () => okJson({ message: "Forbidden" }, 403),
        postBranch: () => { throw new Error("must not recreate when delete is forbidden"); },
      });
      globalThis.fetch = fn;
      const r = await recreateExportBranchFromMaster(cfg);
      assert(r.rebuilt === false && r.detail === "delete_403", `403 delete → rebuilt:false, detail delete_403`);
      assert(!calls.some((c) => c.u.endsWith("/branches") && c.m === "POST"), `no recreate after forbidden delete`);
    }

    // (3) Branch already gone (404 delete) → still recreates → rebuilt.
    {
      const { fn } = makeFetch({ delBranch: () => okJson({ message: "Not Found" }, 404) });
      globalThis.fetch = fn;
      const r = await recreateExportBranchFromMaster(cfg);
      assert(r.rebuilt === true, `404 delete (already gone) still recreates → rebuilt`);
    }

    // (4) Benign 409 on recreate (a concurrent run already made it) → rebuilt.
    {
      const { fn } = makeFetch({
        delBranch: () => okJson({}),
        postBranch: () => okJson({ message: "branch already exists" }, 409),
      });
      globalThis.fetch = fn;
      const r = await recreateExportBranchFromMaster(cfg);
      assert(r.rebuilt === true, `409 on recreate (race) is benign → rebuilt`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("\nAll export smoke checks passed.");
