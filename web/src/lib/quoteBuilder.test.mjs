// Regression tests for issue #355 — the quote picker / builder walks
// (`collectUhbWords`, `collectTargetTokens`) must descend `\qs`-style
// character wrappers the same way the highlight matchers do, or a
// `\qs`-wrapped `\w` is invisible to the picker while the matcher sees it.
//
// These PARSE REAL USFM with usfm-js rather than hand-building trees —
// hand-building is exactly how #331's inverted-nesting premise slipped
// through twice. The production ULT Selah shape is `\qs → \zaln → \w`
// (wrapper OUTSIDE the milestone); the byte-identical fixture is
// `alignment.test.mjs` Case 1.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/quoteBuilder.test.mjs
// (also picked up by `npm --workspace web run test`)

import usfm from "usfm-js";
import {
  collectTargetTokens,
  buildQuoteFromSelection,
  tokenKey,
  collectSourceWordNodes,
  quotePickUnchanged,
} from "./quoteBuilder.ts";
import { matchSourceTokens } from "./highlight.ts";
import { isCharacterWrapper, isSourceWordContainer } from "./usfm.ts";
import { nfc } from "./hebrew.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function verseObjectsOf(rawUsfm, ch, v) {
  const json = usfm.toJSON(rawUsfm);
  return json.chapters[ch][v].verseObjects;
}

// ─── Case A: target side — collectTargetTokens over `\qs → \zaln → \w` ───
{
  console.log("\n[Case A] collectTargetTokens descends the \\qs (Selah) wrapper — production ULT shape");
  const target = String.raw`\id PSA
\c 3
\p
\v 8 \q1 \zaln-s |x-strong="H3068" x-content="יְהוָה"\*\w Salvation belongs to Yahweh|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*. \qs \zaln-s |x-strong="H5542" x-lemma="סֶלָה" x-content="סֶלָה"\*\w Selah|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\qs*
`;
  const tvo = verseObjectsOf(target, "3", "8");

  // Premise guards — stop the case silently testing the wrong thing if
  // usfm-js ever changes how it nests the wrapper. The `\qs` must be a
  // top-level node and the `\zaln` must sit INSIDE it.
  const qs = tvo.find((o) => o && o.tag === "qs");
  assert(!!qs, "premise: a top-level \\qs node exists");
  assert(
    !!qs && Array.isArray(qs.children) && qs.children.some((c) => c && c.tag === "zaln"),
    "premise: the \\zaln milestone sits inside the \\qs wrapper",
  );

  const tokens = collectTargetTokens(tvo);
  // Before the fix the wrapped "Selah" token is skipped → only 1 token.
  assert(tokens.length === 2, `both target tokens collected across the wrapper (got ${tokens.length})`);

  const selah = tokens.find((t) => t.text === "Selah");
  assert(!!selah, "the \\qs-wrapped target word 'Selah' is present in the picker token list");
  assert(!!selah && selah.sources.length === 1, "'Selah' carries its single \\zaln source ancestor");
  assert(
    !!selah && selah.sources[0] && selah.sources[0].content === "סֶלָה",
    "'Selah' resolves to source content סֶלָה",
  );
  assert(
    !!selah && selah.sources[0] && selah.sources[0].key === tokenKey("סֶלָה", 1),
    "'Selah' source ancestor key matches tokenKey(סֶלָה, 1)",
  );

  // Control — the unwrapped sibling token in the SAME verse is unchanged.
  const salvation = tokens.find((t) => t.text.startsWith("Salvation"));
  assert(!!salvation, "control: the unwrapped 'Salvation…' token still collects");
  assert(
    !!salvation && salvation.sources[0] && salvation.sources[0].content === "יְהוָה",
    "control: unwrapped token still resolves to יְהוָה",
  );
}

// ─── Case B: source side — collectUhbWords over a `\qs`-wrapped UHB \w ───
{
  console.log("\n[Case B] collectUhbWords / buildQuoteFromSelection descend a \\qs-wrapped source word");
  const source = String.raw`\id PSA
\c 3
\v 8 \w שׁוֹמֵר|x-strong="H8104" x-occurrence="1" x-occurrences="1"\w* \qs \w סֶלָה|x-strong="H5542" x-occurrence="1" x-occurrences="1"\w*\qs*
`;
  const svo = verseObjectsOf(source, "3", "8");

  const qs = svo.find((o) => o && o.tag === "qs");
  assert(!!qs, "premise: a top-level \\qs node exists on the source side");

  // Select ONLY the wrapped word by its key. Before the fix collectUhbWords
  // never yields סֶלָה, so the selection filters to empty and the builder
  // returns null; after the fix it round-trips to the quote סֶלָה @ occ 1.
  const wrapped = buildQuoteFromSelection(svo, new Set([tokenKey("סֶלָה", 1)]));
  assert(!!wrapped, "buildQuoteFromSelection resolves the \\qs-wrapped source word");
  assert(!!wrapped && wrapped.quote === "סֶלָה", `built quote is סֶלָה (got ${wrapped && JSON.stringify(wrapped.quote)})`);
  assert(!!wrapped && wrapped.occurrence === 1, "built quote occurrence is 1");

  // Control — the unwrapped word still builds, before and after the fix.
  const plain = buildQuoteFromSelection(svo, new Set([tokenKey("שׁוֹמֵר", 1)]));
  assert(!!plain && plain.quote === "שׁוֹמֵר", "control: the unwrapped source word still builds");

  // Both together, in document order, joined by the disjoint-run gap (they
  // are non-consecutive because the wrapper sits between them positionally
  // only in text; collectUhbWords flattens both into one run since no other
  // \w intervenes) — proves the wrapped word takes a real document position.
  const both = buildQuoteFromSelection(
    svo,
    new Set([tokenKey("שׁוֹמֵר", 1), tokenKey("סֶלָה", 1)]),
  );
  assert(!!both && both.quote === "שׁוֹמֵר סֶלָה", `both words join in order (got ${both && JSON.stringify(both.quote)})`);
}

// ─── Case C: a wrapper-less tree is untouched ───────────────────────────
{
  console.log("\n[Case C] control — a verse with no \\qs takes the identical path");
  const target = String.raw`\id PSA
\c 1
\p
\v 1 \zaln-s |x-strong="H0835" x-content="אַשְׁרֵי"\*\w Blessed|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
`;
  const tvo = verseObjectsOf(target, "1", "1");
  const tokens = collectTargetTokens(tvo);
  assert(tokens.length === 1 && tokens[0].text === "Blessed", "wrapper-less target verse collects unchanged");
}

// ─── Case D (issue #364): the shared source-word walk `collectSourceWordNodes`
//     descends the `\qs` wrapper, keeps every word's document position, and its
//     order matches `matchSourceTokens`. This is the ONE traversal the picker
//     chips (QuoteBuilderPopper) and the flows spine (VerseSpineModel) now
//     project off, so a drift here is a drift in both.
{
  console.log("\n[Case D] collectSourceWordNodes descends \\qs; positions align with matchSourceTokens (#364)");
  // plain — wrapped — plain, so a dropped/shifted wrapped word would misplace
  // the word AFTER it (the exact #354 divergence this closes).
  const source = String.raw`\id PSA
\c 3
\v 8 \w אֶחָד|x-strong="H0259" x-occurrence="1" x-occurrences="1"\w* \qs \w סֶלָה|x-strong="H5542" x-occurrence="1" x-occurrences="1"\w*\qs* \w שָׁלוֹם|x-strong="H7965" x-occurrence="1" x-occurrences="1"\w*
`;
  const svo = verseObjectsOf(source, "3", "8");

  const qs = svo.find((o) => o && o.tag === "qs");
  assert(!!qs, "premise: a top-level \\qs node exists");
  assert(!!qs && isCharacterWrapper(qs), "premise: the \\qs node is a character wrapper");

  const nodes = collectSourceWordNodes(svo);
  const texts = nodes.map((n) => String(n.node.text ?? ""));
  const positions = nodes.map((n) => n.position);
  // Before the fix the popper/spine copies skipped the wrapper → 2 words and a
  // gap at position 1.
  assert(nodes.length === 3, `all three source words collected across the wrapper (got ${nodes.length})`);
  assert(
    texts.join("|") === "אֶחָד|סֶלָה|שָׁלוֹם",
    `words are in document order incl. the wrapped one (got ${texts.join("|")})`,
  );
  assert(positions.join(",") === "0,1,2", `positions are contiguous 0..2 (got ${positions.join(",")})`);

  // The wrapped word sits at position 1 and the word AFTER it at 2 — no drift.
  const selahPos = nodes.findIndex((n) => n.node.text === "סֶלָה");
  const shalomPos = nodes.findIndex((n) => n.node.text === "שָׁלוֹם");
  assert(selahPos === 1 && shalomPos === 2, `wrapped word at 1, following word at 2 (got ${selahPos}, ${shalomPos})`);

  // matchSourceTokens walks the SAME order (it uses the wrapper-aware
  // collectBareWords). A quote spanning the wrapper boundary resolves the two
  // words adjacently, matching their consecutive positions above.
  const m = matchSourceTokens(svo, "סֶלָה שָׁלוֹם", 1);
  assert(m.length === 2, `matchSourceTokens spans the wrapper boundary (got ${m.length})`);
  assert(
    m.map((t) => t.text).join("|") === "סֶלָה|שָׁלוֹם",
    `matcher order matches the walk across the wrapper (got ${m.map((t) => t.text).join("|")})`,
  );
  assert(shalomPos === selahPos + 1, "walk adjacency matches the matcher's adjacency");
}

// ─── Case E (issue #364, item 2): a CHILDLESS \qs parks its text on the wrapper
//     node itself, so the renderer must emit that text — the walk finds no \w.
//     This is the parsed-USFM premise behind the HebrewLine.tsx fix (the render
//     itself is a browser check; the node runner can't mount React/JSX).
{
  console.log("\n[Case E] childless / unclosed \\qs parks its text on the node, no \\w child (#364 item 2)");
  const closed = verseObjectsOf(
    String.raw`\id PSA
\c 3
\v 8 \w foo|x-occurrence="1" x-occurrences="1"\w* \qs Selah\qs*
`,
    "3",
    "8",
  );
  const closedQs = closed.find((o) => o && o.tag === "qs");
  assert(!!closedQs && isCharacterWrapper(closedQs), "premise: childless \\qs is a character wrapper");
  assert(closedQs.text === "Selah", `childless \\qs carries its text on the node (got ${JSON.stringify(closedQs && closedQs.text)})`);
  assert(
    !Array.isArray(closedQs.children) || closedQs.children.length === 0,
    "childless \\qs has no children — descending children alone renders nothing",
  );
  // The wrapper is not a \w, so the source-word walk yields nothing for it: the
  // text is only recoverable by emitting the wrapper node's own `text`.
  assert(
    collectSourceWordNodes(closed).every((n) => n.node.text !== "Selah"),
    "the walk yields no word for a childless-wrapper's text (renderer must emit node.text)",
  );

  const unclosed = verseObjectsOf(
    String.raw`\id PSA
\c 3
\v 8 \w foo|x-occurrence="1" x-occurrences="1"\w* \qs Selah
`,
    "3",
    "8",
  );
  const unclosedQs = unclosed.find((o) => o && o.tag === "qs");
  assert(!!unclosedQs && isCharacterWrapper(unclosedQs), "premise: unclosed \\qs is still a character wrapper");
  assert(
    typeof unclosedQs.text === "string" && unclosedQs.text.startsWith("Selah"),
    `unclosed \\qs also parks its text on the node (got ${JSON.stringify(unclosedQs && unclosedQs.text)})`,
  );
}

// ─── Case F (issue #370): the source-word walk descends ONLY `\zaln` alignment
//     milestones, not other milestone kinds. A `\k-s`/`\k-e` keyterm milestone
//     with a `\w` child used to be descended by `collectSourceWordNodes` (which
//     walked ANY `type:"milestone"`) but NOT by the zaln-only matcher — so the
//     picker minted an extra source word and every word AFTER the keyterm drifted
//     by one relative to `matchSourceTokens`. Both walks now route their milestone
//     gate through the shared `isZalnMilestone`, so they agree.
{
  console.log("\n[Case F] source walk descends only \\zaln, not \\k keyterm milestones; parity with matchSourceTokens (#370)");
  // plain — \k-wrapped — plain: if the wrapped word were (mis)collected, the
  // word AFTER it would land at position 2 in the picker but position 1 in the
  // matcher — the exact drift #370 closes.
  const source = String.raw`\id PSA
\c 1
\p
\v 1 \w one|x-occurrence="1" x-occurrences="1"\w* \k-s |x-content="two"\*\w two|x-occurrence="1" x-occurrences="1"\w*\k-e\* \w three|x-occurrence="1" x-occurrences="1"\w*
`;
  const svo = verseObjectsOf(source, "1", "1");

  const kNode = svo.find((o) => o && o.type === "milestone" && o.tag === "k");
  assert(!!kNode, "premise: a \\k keyterm milestone (type:milestone, tag:k) exists at top level");
  assert(
    !!kNode && Array.isArray(kNode.children) && kNode.children.some((c) => c && c.tag === "w" && c.text === "two"),
    "premise: the \\k milestone wraps a \\w child (\"two\") — the divergence probe",
  );

  const nodes = collectSourceWordNodes(svo);
  const texts = nodes.map((n) => String(n.node.text ?? ""));
  const positions = nodes.map((n) => n.position);
  // The \k-wrapped word is NOT verse-body source for alignment purposes, so the
  // walk skips it — leaving the two plain words contiguous at 0,1.
  assert(
    texts.join("|") === "one|three",
    `only non-keyterm source words collected, in order (got ${texts.join("|")})`,
  );
  assert(positions.join(",") === "0,1", `positions stay contiguous 0..1 — no keyterm drift (got ${positions.join(",")})`);

  // Parity: matchSourceTokens uses the SAME milestone gate (collectBareWords →
  // isZalnMilestone), so it walks the identical word set in the identical order.
  const spanning = matchSourceTokens(svo, "one three", 1);
  assert(
    spanning.map((t) => t.text).join("|") === "one|three",
    `matcher walks the same word set across the keyterm milestone (got ${spanning.map((t) => t.text).join("|")})`,
  );
  // The word after the keyterm resolves adjacent to the word before it in BOTH
  // walks — proving the two never disagree on keyterm descent.
  const three = matchSourceTokens(svo, "three", 1);
  assert(three.length === 1 && three[0].text === "three", "matcher resolves the post-keyterm word (parity anchor)");
  assert(
    nodes.findIndex((n) => n.node.text === "three") === 1,
    "picker places the post-keyterm word at the same position the matcher counts to",
  );

  // A quote naming the keyterm-wrapped word matches nothing in EITHER walk — the
  // picker can't mint it and the matcher can't highlight it, so they stay
  // consistent rather than one offering a chip the other can never resolve.
  assert(
    collectSourceWordNodes(svo).every((n) => n.node.text !== "two"),
    "picker offers no chip for the \\k-wrapped word",
  );
  assert(matchSourceTokens(svo, "two", 1).length === 0, "matcher highlights nothing for the \\k-wrapped word");
}

// ─── Case G (issue #370 item 2): every position-bearing SOURCE walk in the
//     aligner now enumerates words through the ONE descent rule. Eight sites used
//     to hand-roll `type === "milestone"` and none descended `\qs`, so a wrapped
//     source word both vanished from their counts and shifted every position
//     after it: Shell/AlignScreen/TranslateAlignScreen `countSourceWords` (the
//     side-by-side posOffsets), AlignmentPanel/AlignSourceModel
//     `buildSourceIndexMap` + `allStrongs`, and UhbStrip's `wordPos`.
//
//     Six of those now call `collectSourceWordNodes` outright, so this case
//     covers them directly (count + position + Strong's). UhbStrip renders as it
//     walks — it interleaves text nodes, so it can't project off the collector
//     and instead gates on the shared `isSourceWordContainer` predicate. React
//     can't be mounted in the node runner, so the walk is REBUILT here in the
//     component's exact shape and asserted word-for-word against the collector:
//     that parity is the guarantee the strip's `pos` and the panel's index map
//     line up. Hebrew comparisons go through nfc() — a `\qs`-wrapped UHB word
//     carries legacy combining-mark order while the fixture literal is NFC.
{
  console.log("\n[Case G] every source walk shares one descent rule; \\qs-wrapped word keeps its position (#370 item 2)");
  // The production ULT/UHB Selah shape with the wrapper OUTSIDE the milestone
  // (`\qs → \zaln → \w`, alignment.test.mjs Case 1), placed MID-verse so a
  // skipped wrapper would misplace the word after it.
  const source = String.raw`\id PSA
\c 3
\p
\v 8 \zaln-s |x-strong="H0259" x-content="אֶחָד"\*\w אֶחָד|x-strong="H0259" x-occurrence="1" x-occurrences="1"\w*\zaln-e\* \qs \zaln-s |x-strong="H5542" x-content="סֶלָה"\*\w סֶלָה|x-strong="H5542" x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\qs* \zaln-s |x-strong="H7965" x-content="שָׁלוֹם"\*\w שָׁלוֹם|x-strong="H7965" x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
`;
  const svo = verseObjectsOf(source, "3", "8");

  // Premise guards — the wrapper must sit at top level with the \zaln INSIDE it,
  // or the case silently tests a shape the components never see.
  const qs = svo.find((o) => o && o.tag === "qs");
  assert(!!qs && isCharacterWrapper(qs), "premise: a top-level \\qs character wrapper exists");
  assert(
    !!qs && Array.isArray(qs.children) && qs.children.some((c) => c && c.tag === "zaln"),
    "premise: the \\zaln milestone sits INSIDE the \\qs wrapper (production Selah shape)",
  );
  assert(isSourceWordContainer(qs), "premise: the shared predicate treats the \\qs wrapper as a container to descend");

  const nodes = collectSourceWordNodes(svo);
  const want = ["אֶחָד", "סֶלָה", "שָׁלוֹם"].map(nfc);

  // countSourceWords (Shell posOffsets, AlignScreen, TranslateAlignScreen) is
  // now exactly this length. The old walks returned 2 — the panel offset was one
  // short and every downstream position slid.
  assert(nodes.length === 3, `countSourceWords counts the wrapped word (got ${nodes.length}, was 2 before the fix)`);
  assert(
    nodes.map((n) => nfc(String(n.node.text ?? ""))).join("|") === want.join("|"),
    "words enumerate in document order across the wrapper",
  );
  assert(
    nodes.map((n) => n.position).join(",") === "0,1,2",
    `positions are contiguous 0..2 — the word AFTER the wrapper does not drift (got ${nodes.map((n) => n.position).join(",")})`,
  );

  // buildSourceIndexMap (AlignmentPanel + AlignSourceModel) keys `t:<nfc>|<occ>`
  // off these same nodes, so the wrapped word resolves and the following word
  // keeps position 2 rather than collapsing onto 1.
  const indexMap = new Map();
  const textCount = new Map();
  for (const { node, position } of nodes) {
    const text = nfc(String(node.text ?? ""));
    const tOcc = (textCount.get(text) ?? 0) + 1;
    textCount.set(text, tOcc);
    if (!indexMap.has(`t:${text}|${tOcc}`)) indexMap.set(`t:${text}|${tOcc}`, position);
  }
  assert(indexMap.get(`t:${nfc("סֶלָה")}|1`) === 1, "index map resolves the \\qs-wrapped word at position 1");
  assert(indexMap.get(`t:${nfc("שָׁלוֹם")}|1`) === 2, "index map keeps the word after the wrapper at position 2");

  // allStrongs (AlignmentPanel + AlignSourceModel): the wrapped word's Strong's
  // must reach the lexicon prefetch / suggest keys.
  const strongs = nodes.map((n) => String(n.node.strong ?? ""));
  assert(strongs.includes("H5542"), `the \\qs-wrapped word's Strong's is collected (got ${strongs.join(",")})`);

  // UhbStrip's wordPos walk, rebuilt in the component's exact shape: text nodes
  // are emitted (not counted), \w tokens take the next position, and descent is
  // gated on the SHARED predicate. It must agree with the collector word-for-word.
  const stripWords = [];
  let wordPos = 0;
  const stripWalk = (ns) => {
    for (const o of ns ?? []) {
      if (!o) continue;
      if (o.type === "text") continue; // rendered, never counted
      else if (o.type === "word" && o.tag === "w") stripWords.push({ text: nfc(String(o.text ?? "")), pos: wordPos++ });
      else if (isSourceWordContainer(o)) stripWalk(o.children ?? []);
    }
  };
  stripWalk(svo);
  assert(
    stripWords.map((w) => `${w.text}@${w.pos}`).join("|") ===
      nodes.map((n) => `${nfc(String(n.node.text ?? ""))}@${n.position}`).join("|"),
    "UhbStrip's predicate-gated render walk matches the shared collector word-for-word and position-for-position",
  );

  // The rule really is ONE rule: a `\k` keyterm milestone stays undescended by
  // the predicate too, so the strip walk can't reintroduce Case F's drift.
  const keyterm = verseObjectsOf(
    String.raw`\id PSA
\c 1
\v 1 \w one|x-occurrence="1" x-occurrences="1"\w* \k-s |x-content="two"\*\w two|x-occurrence="1" x-occurrences="1"\w*\k-e\* \w three|x-occurrence="1" x-occurrences="1"\w*
`,
    "1",
    "1",
  );
  const kNode = keyterm.find((o) => o && o.type === "milestone" && o.tag === "k");
  assert(!!kNode, "premise: a \\k keyterm milestone exists");
  assert(!isSourceWordContainer(kNode), "the shared predicate does NOT descend a \\k keyterm milestone");
  assert(
    isSourceWordContainer(keyterm.find((o) => o && o.type === "milestone" && o.tag === "zaln") ?? { type: "milestone", tag: "zaln" }),
    "the shared predicate DOES descend a \\zaln alignment milestone",
  );
}

// ── quotePickUnchanged (issue #593 / PR #557) ──────────────────────────────
// The notes screen's quote picker skips the PATCH when the pick equals the
// stored quote. UHB legacy order (consonant-dagesh-vowel) vs an NFC stored
// quote must count as the same; a null stored occurrence means 1.
{
  const legacy = "בַּיּוֹם"; // בּ+dagesh+patah...
  const stored = legacy.normalize("NFC");
  assert(legacy !== stored, "premise: legacy and NFC spellings differ byte-wise");
  assert(quotePickUnchanged({ quote: legacy, occurrence: 1 }, stored, 1), "legacy vs NFC quote, same occurrence → unchanged");
  assert(quotePickUnchanged({ quote: legacy, occurrence: 1 }, stored, null), "null stored occurrence counts as 1");
  assert(!quotePickUnchanged({ quote: legacy, occurrence: 2 }, stored, 1), "different occurrence → changed");
  assert(!quotePickUnchanged({ quote: legacy, occurrence: 2 }, stored, null), "occurrence 2 vs null (=1) → changed");
  assert(!quotePickUnchanged({ quote: "καὶ", occurrence: 1 }, "", null), "a quote picked for an empty row → changed");
  assert(!quotePickUnchanged({ quote: "καὶ", occurrence: 1 }, "καὶ ἐγένετο", 1), "different words → changed");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll quoteBuilder \\qs-wrapper regression assertions passed.");
