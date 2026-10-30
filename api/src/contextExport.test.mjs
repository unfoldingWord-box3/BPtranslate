// Unit tests for contextExport.ts + contextExportLib.ts (pure renderer + gates).
// Run: node --experimental-strip-types --no-warnings src/contextExport.test.mjs

import {
  renderManifestYaml,
  renderBriefMd,
  renderContextPack,
  renderInstructionsMd,
  buildValidatedExamples,
  renderValidatedJsonl,
  renderTemplatesTsv,
  tsvField,
  hasMinimumContent,
  hasSemanticContent,
  buildContextRef,
  contextRepoOwner,
  sourceRowKey,
  VALIDATED_TN_EXAMPLES_SQL,
  VALIDATED_TQ_EXAMPLES_SQL,
  loadContextPackInputs,
  loadQueuedContextInputs,
  sameQueuedContextInputs,
} from "./contextExport.ts";
import {
  contextShrinkRefused,
  shrinkDetailCode,
  nfc,
  contentFileCount,
  briefHasSemanticValue,
  stalePackPaths,
} from "./contextExportLib.ts";
import { applyContextRef } from "./assistedContextRef.ts";
import { tsvLooksTruncated } from "./contextSourceFetch.ts";
import { PRESETS } from "./projectConfig.ts";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const cfg = {
  languageCode: "ar",
  languageName: "Arabic",
  languageTitle: "العربية",
  direction: "rtl",
  exportOrg: "BSOJ",
  org: "BSOJ",
};

console.log("contextExport — manifest / brief");
{
  const m = renderManifestYaml({
    languageCode: "ar",
    direction: "rtl",
    exportedAt: new Date("2026-07-14T12:00:00.000Z"),
  });
  assert(m.includes("format: 1"), "manifest has format: 1");
  assert(m.includes("language: ar"), "manifest has language");
  assert(m.includes("direction: rtl"), "manifest has direction");
  assert(m.includes("exported_by: bible-editor"), "manifest has exported_by");
  assert(m.includes("exported_at: 2026-07-14T12:00:00Z"), "manifest ISO time without ms");

  const brief = renderBriefMd(
    { audience: "teams", purpose: "notes", register: "formal", script_notes: "RTL", instructions_md: null, common_issues_md: null },
    "العربية",
    "ar",
  );
  assert(brief.includes("**Register:** formal"), "brief Register line for bot parse");
  assert(brief.includes("**Audience:** teams"), "brief audience");
}

console.log("contextExport — NFC + examples");
{
  // Hebrew with combining marks in legacy vs NFC order.
  const legacy = "\u05D1\u05BC\u05B8"; // bet + dagesh + qamats (common UHB order)
  const already = legacy.normalize("NFC");
  assert(nfc(legacy) === already, "nfc() folds Hebrew combining marks");

  const ex = buildValidatedExamples(
    [
      {
        id: "abcd",
        book: "OBA",
        ref_raw: "1:1",
        support_reference: "figs-metaphor",
        quote: null,
        note: "هذا مجاز.",
        updated_at: 100,
      },
    ],
    [],
    {
      tn: new Map([[sourceRowKey("OBA", "abcd"), { note: "This is a metaphor.", quote: null }]]),
      tq: new Map(),
    },
  );
  assert(ex.ok === true, "examples ok with EN source");
  assert(ex.ok && ex.lines[0].source === "This is a metaphor.", "example source from EN map");

  const miss = buildValidatedExamples(
    [{ id: "zzzz", book: "OBA", ref_raw: "1:1", support_reference: null, quote: null, note: "x", updated_at: 1 }],
    [],
    { tn: new Map(), tq: new Map() },
  );
  assert(miss.ok === false && miss.reason.includes("missing_en_source"), "missing EN aborts");

  // Collision regression: identical 4-char IDs in two books must not cross-pair.
  const collision = buildValidatedExamples(
    [
      {
        id: "abcd",
        book: "OBA",
        ref_raw: "1:1",
        support_reference: null,
        quote: null,
        note: "oba-target",
        updated_at: 10,
      },
      {
        id: "abcd",
        book: "ZEC",
        ref_raw: "1:1",
        support_reference: null,
        quote: null,
        note: "zec-target",
        updated_at: 20,
      },
    ],
    [],
    {
      tn: new Map([
        [sourceRowKey("OBA", "abcd"), { note: "OBA English source", quote: null }],
        [sourceRowKey("ZEC", "abcd"), { note: "ZEC English source", quote: null }],
      ]),
      tq: new Map(),
    },
  );
  assert(collision.ok === true, "same id across books resolves");
  assert(
    collision.ok &&
      collision.lines.find((l) => l.book === "OBA")?.source === "OBA English source" &&
      collision.lines.find((l) => l.book === "ZEC")?.source === "ZEC English source",
    "book:id key prevents cross-book EN source overwrite",
  );
  assert(sourceRowKey("oba", "abcd") === "OBA:abcd", "sourceRowKey uppercases book");

  const jsonl = renderValidatedJsonl(ex.ok ? ex.lines : []);
  assert(jsonl.includes('"resource":"tn"'), "jsonl serializes resource");
  assert(jsonl.endsWith("\n"), "jsonl trailing newline");
}

console.log("contextExport — full pack + omission rules");
{
  const emptyInstructions = renderContextPack({
    cfg,
    prefs: {
      audience: "a",
      purpose: "p",
      register: "default",
      script_notes: null,
      instructions_md: null,
      common_issues_md: null,
    },
    terms: [],
    tnRows: [],
    tqRows: [],
    sources: { tn: new Map(), tq: new Map() },
    templates: [],
    exportedAt: new Date("2026-07-14T12:00:00Z"),
  });
  assert(emptyInstructions.ok === true, "pack renders with brief alone");
  assert(
    emptyInstructions.ok && !emptyInstructions.files.some((f) => f.path === "instructions.md"),
    "omits empty instructions.md",
  );
  assert(
    emptyInstructions.ok && !emptyInstructions.files.some((f) => f.path === "examples/validated.jsonl"),
    "omits empty examples",
  );
  assert(emptyInstructions.ok && hasMinimumContent(emptyInstructions.files), "brief counts as file-level content");
  // Scaffold-only prefs (empty fields + default register) must NOT enable assisted.
  assert(
    !hasSemanticContent({
      prefs: {
        audience: null,
        purpose: null,
        register: "default",
        script_notes: null,
        instructions_md: null,
        common_issues_md: null,
      },
      terms: 0,
      examplesTn: 0,
      examplesTq: 0,
      templates: 0,
    }),
    "scaffold-only prefs fail semantic gate",
  );
  assert(
    hasSemanticContent({
      prefs: {
        audience: "a",
        purpose: "p",
        register: "default",
        script_notes: null,
        instructions_md: null,
        common_issues_md: null,
      },
      terms: 0,
      examplesTn: 0,
      examplesTq: 0,
      templates: 0,
    }),
    "audience+purpose count as semantic",
  );
  assert(!briefHasSemanticValue({ audience: null, purpose: null, register: "default", script_notes: null }), "default register alone is not semantic");
  assert(briefHasSemanticValue({ audience: null, purpose: null, register: "formal", script_notes: null }), "non-default register is semantic");
  assert(
    hasSemanticContent({
      prefs: {
        audience: null,
        purpose: null,
        register: "default",
        script_notes: null,
        instructions_md: null,
        common_issues_md: null,
      },
      terms: 1,
      examplesTn: 0,
      examplesTq: 0,
      templates: 0,
    }),
    "one term satisfies semantic gate",
  );
  // Common issues alone (everything else null/default/zero) must satisfy the
  // semantic gate — a project whose only content is a pasted "common issues"
  // doc must not be discarded as scaffold-only.
  assert(
    hasSemanticContent({
      prefs: {
        audience: null,
        purpose: null,
        register: "default",
        script_notes: null,
        instructions_md: null,
        common_issues_md: "Translators keep confusing grace and mercy.",
      },
      terms: 0,
      examplesTn: 0,
      examplesTq: 0,
      templates: 0,
    }),
    "common_issues_md alone satisfies semantic gate",
  );
  assert(
    !hasSemanticContent({
      prefs: {
        audience: null,
        purpose: null,
        register: "default",
        script_notes: null,
        instructions_md: null,
        common_issues_md: "   ",
      },
      terms: 0,
      examplesTn: 0,
      examplesTq: 0,
      templates: 0,
    }),
    "whitespace-only common_issues_md fails semantic gate",
  );

  const withTerms = renderContextPack({
    cfg,
    prefs: {
      audience: null,
      purpose: null,
      register: "informal",
      script_notes: null,
      instructions_md: "Do the thing\n",
      common_issues_md: null,
    },
    terms: [
      {
        concept_id: "kt/grace",
        source_term: "grace",
        target_term: "نعمة",
        status: "preferred",
        replacement: null,
        comment: null,
        tw_link: null,
      },
    ],
    tnRows: [],
    tqRows: [],
    sources: { tn: new Map(), tq: new Map() },
    templates: [],
  });
  assert(withTerms.ok && withTerms.stats.terms === 1, "terms count");
  assert(
    withTerms.ok && withTerms.files.some((f) => f.path === "terminology/terms.csv"),
    "emits terms.csv",
  );
  assert(
    withTerms.ok && withTerms.files.some((f) => f.path === "instructions.md"),
    "emits instructions when present",
  );
}

console.log("contextExport — partial source: sourceless resource is SKIPPED, export still succeeds");
{
  // Regression (PR #86 review): tN source blank in Setup (skipped:['tn']) with a
  // VALIDATED tN row + a sourced tQ row. The empty tn source map must NOT trip
  // missing_en_source — the tN row is skipped, and tQ examples + prefs + terms
  // still export. Before the fix, this failed the WHOLE context export.
  const r = renderContextPack({
    cfg,
    prefs: {
      audience: "teams",
      purpose: "notes",
      register: "formal",
      script_notes: null,
      instructions_md: "Keep it simple\n",
      common_issues_md: null,
    },
    terms: [
      {
        concept_id: "kt/grace",
        source_term: "grace",
        target_term: "نعمة",
        status: "preferred",
        replacement: null,
        comment: null,
        tw_link: null,
      },
    ],
    // A validated tN row with NO EN source (tn skipped) + a tQ row WITH source.
    tnRows: [
      { id: "n1", book: "TIT", ref_raw: "1:1", support_reference: "figs-metaphor", quote: null, note: "ملاحظة", updated_at: 10 },
    ],
    tqRows: [
      { id: "q1", book: "TIT", ref_raw: "1:1", question: "من؟", response: "الله.", updated_at: 20 },
    ],
    sources: {
      tn: new Map(), // empty — tn was skipped (no upstream source)
      tq: new Map([[sourceRowKey("TIT", "q1"), { question: "Who?", response: "God." }]]),
    },
    templates: [],
    skipped: ["tn"],
  });
  assert(r.ok, "export SUCCEEDS despite a sourceless tN with validated rows (no missing_en_source)");
  assert(r.ok && r.stats.examplesTn === 0, "tN examples empty (skipped resource)");
  assert(r.ok && r.stats.examplesTq === 1, "tQ example still exported (sourced resource)");
  assert(r.ok && r.stats.terms === 1, "terms still exported");
  assert(r.ok && r.files.some((f) => f.path === "instructions.md"), "prefs/instructions still exported");
  assert(
    r.ok && r.files.some((f) => f.path === "examples/validated.jsonl"),
    "validated.jsonl emitted from the tQ example",
  );

  // Without skipped, the same empty tn map WOULD fail (proves skipped is what saves it).
  const wouldFail = renderContextPack({
    cfg,
    prefs: { audience: null, purpose: null, register: "default", script_notes: null, instructions_md: null, common_issues_md: null },
    terms: [],
    tnRows: [
      { id: "n1", book: "TIT", ref_raw: "1:1", support_reference: null, quote: null, note: "ملاحظة", updated_at: 10 },
    ],
    tqRows: [],
    sources: { tn: new Map(), tq: new Map() },
    templates: [],
  });
  assert(!wouldFail.ok && wouldFail.reason.includes("missing_en_source:tn"), "empty tn map without skipped still hard-fails (control)");
}

console.log("contextExport — renderInstructionsMd");
{
  const basePrefs = { audience: null, purpose: null, register: "default", script_notes: null };

  assert(
    renderInstructionsMd({ ...basePrefs, instructions_md: null, common_issues_md: null }) === null,
    "both empty → null",
  );
  assert(
    renderInstructionsMd({ ...basePrefs, instructions_md: "  ", common_issues_md: "   " }) === null,
    "both whitespace-only → null",
  );
  assert(
    renderInstructionsMd({ ...basePrefs, instructions_md: "Do the thing", common_issues_md: null }) ===
      "Do the thing\n",
    "only instructions_md → its text + trailing newline, no heading",
  );
  assert(
    renderInstructionsMd({ ...basePrefs, instructions_md: null, common_issues_md: "Watch for false friends." }) ===
      "## Common issues\n\nWatch for false friends.\n",
    "only common_issues_md → heading followed by the text",
  );
  assert(
    renderInstructionsMd({
      ...basePrefs,
      instructions_md: "Do the thing",
      common_issues_md: "Watch for false friends.",
    }) === "Do the thing\n\n## Common issues\n\nWatch for false friends.\n",
    "both → instructions first, blank line, then heading + issues",
  );

  // Regression: common_issues_md alone must not be silently dropped from the
  // rendered pack — instructions.md must still be emitted.
  const onlyCommonIssues = renderContextPack({
    cfg,
    prefs: {
      audience: null,
      purpose: null,
      register: "default",
      script_notes: null,
      instructions_md: null,
      common_issues_md: "Avoid the colloquial future particle in narrative.",
    },
    terms: [],
    tnRows: [],
    tqRows: [],
    sources: { tn: new Map(), tq: new Map() },
    templates: [],
    exportedAt: new Date("2026-07-14T12:00:00Z"),
  });
  assert(
    onlyCommonIssues.ok &&
      onlyCommonIssues.files.find((f) => f.path === "instructions.md")?.content ===
        "## Common issues\n\nAvoid the colloquial future particle in narrative.\n",
    "renderContextPack emits instructions.md when only common_issues_md is set",
  );
}

console.log("contextExport — renderTemplatesTsv");
{
  assert(renderTemplatesTsv([]) === null, "empty input -> null");

  // Two variants share support_ref: first (by sort order) wins, second skipped.
  const twoVariants = renderTemplatesTsv([
    { template_id: "figs-metaphor-01", support_ref: "figs-metaphor", sheet_order: 1, type: "note", target_md: "أول" },
    { template_id: "figs-metaphor-02", support_ref: "figs-metaphor", sheet_order: 2, type: "note", target_md: "ثاني" },
  ]);
  const twoVariantLines = twoVariants.split("\n").filter(Boolean);
  assert(twoVariantLines[0] === "support_reference\ttarget_template\tstatus\tcomment", "exact header");
  assert(twoVariantLines.length === 2, "one row per slug (dedup)");
  assert(twoVariantLines[1] === "figs-metaphor\tأول\tactive\tnote", "first unit wins");

  // Empty/whitespace-only target_md is skipped entirely.
  const emptyTarget = renderTemplatesTsv([
    { template_id: "figs-idiom-01", support_ref: "figs-idiom", sheet_order: 1, type: null, target_md: "   " },
  ]);
  assert(emptyTarget === null, "whitespace-only target_md -> null (no rows)");

  // Sanitization: embedded tab/CR/LF collapse to single spaces, one physical line.
  const dirty = renderTemplatesTsv([
    {
      template_id: "figs-simile-01",
      support_ref: "figs-simile",
      sheet_order: 1,
      type: "note",
      target_md: "line one\r\nline\ttwo\n\nline three",
    },
  ]);
  const dirtyLines = dirty.split("\n").filter(Boolean);
  assert(dirtyLines.length === 2, "dirty target renders as exactly one physical data line");
  assert(
    dirtyLines[1] === "figs-simile\tline one line two line three\tactive\tnote",
    "tabs/CRLF/blank-line runs collapse to single spaces",
  );
  assert(tsvField("a\tb\r\nc") === "a b c", "tsvField collapses tab/cr/lf runs");
  assert(tsvField("  x  ") === "x", "tsvField trims");

  // A tab/newline-only target passes SQLite TRIM (spaces only) but flattens to
  // empty here — it must NOT claim the slug, so the later valid variant wins.
  const emptyFirstVariant = renderTemplatesTsv([
    { template_id: "figs-hyper-01", support_ref: "figs-hyperbole", sheet_order: 1, type: "note", target_md: "\t\n" },
    { template_id: "figs-hyper-02", support_ref: "figs-hyperbole", sheet_order: 2, type: "note", target_md: "REAL" },
  ]);
  const emptyFirstLines = emptyFirstVariant.split("\n").filter(Boolean);
  assert(emptyFirstLines.length === 2, "empty-flattening first variant does not consume the slug");
  assert(emptyFirstLines[1] === "figs-hyperbole\tREAL\tactive\tnote", "later valid variant exports");

  // Dedupe keys on the FLATTENED slug: raw slugs differing only by whitespace
  // must collapse to one row (the bot's Map is last-duplicate-wins; two rows
  // for one slug would silently invert first-wins).
  const wsSlugs = renderTemplatesTsv([
    { template_id: "figs-irony-01", support_ref: "figs-irony", sheet_order: 1, type: "note", target_md: "first" },
    { template_id: "figs-irony-02", support_ref: "figs-irony ", sheet_order: 2, type: "note", target_md: "second" },
  ]);
  const wsSlugLines = wsSlugs.split("\n").filter(Boolean);
  assert(wsSlugLines.length === 2, "whitespace-variant slugs collapse to one row");
  assert(wsSlugLines[1] === "figs-irony\tfirst\tactive\tnote", "first flattened-slug variant wins");

  // Round-trip shape: N data lines each with exactly 3 tabs (4 columns).
  const multi = renderTemplatesTsv([
    { template_id: "a1", support_ref: "figs-a", sheet_order: 1, type: "note", target_md: "A" },
    { template_id: "b1", support_ref: "figs-b", sheet_order: 1, type: null, target_md: "B" },
  ]);
  const multiLines = multi.split("\n").filter(Boolean);
  assert(multiLines.length === 3, "header + 2 data lines");
  for (const line of multiLines.slice(1)) {
    assert((line.match(/\t/g) || []).length === 3, `data line has exactly 3 tabs: ${line}`);
  }
  assert(multi.endsWith("\n"), "trailing newline");

  // renderContextPack integration: 1 validated template and nothing else.
  const withTemplates = renderContextPack({
    cfg,
    prefs: { audience: null, purpose: null, register: "default", script_notes: null, instructions_md: null, common_issues_md: null },
    terms: [],
    tnRows: [],
    tqRows: [],
    sources: { tn: new Map(), tq: new Map() },
    templates: [
      { template_id: "figs-metaphor-01", support_ref: "figs-metaphor", sheet_order: 1, type: "note", target_md: "استعارة" },
    ],
  });
  assert(withTemplates.ok, "renders with just a template");
  assert(
    withTemplates.ok && withTemplates.files.some((f) => f.path === "templates/templates.tsv"),
    "emits templates/templates.tsv",
  );
  assert(withTemplates.ok && withTemplates.stats.templates === 1, "stats.templates === 1");
  assert(
    hasSemanticContent({
      prefs: { audience: null, purpose: null, register: "default", script_notes: null, instructions_md: null, common_issues_md: null },
      terms: 0,
      examplesTn: 0,
      examplesTq: 0,
      templates: 1,
    }),
    "hasSemanticContent true with templates:1",
  );
  assert(
    !hasSemanticContent({
      prefs: { audience: null, purpose: null, register: "default", script_notes: null, instructions_md: null, common_issues_md: null },
      terms: 0,
      examplesTn: 0,
      examplesTq: 0,
      templates: 0,
    }),
    "hasSemanticContent false with all zero (including templates)",
  );
}

console.log("contextExportLib — shrink + content count");
{
  assert(contentFileCount([{ path: "manifest.yaml", content: "x" }]) === 0, "manifest alone = 0 content");
  assert(
    !contextShrinkRefused(
      { terms: 10, examplesTn: 5, examplesTq: 0, templates: 40, contentFiles: 3, totalBytes: 1000 },
      null,
    ),
    "first export: no shrink",
  );
  const refused = contextShrinkRefused(
    { terms: 2, examplesTn: 5, examplesTq: 0, templates: 40, contentFiles: 3, totalBytes: 1000 },
    { terms: 100, examplesTn: 5, examplesTq: 0, templates: 40, contentFiles: 3, totalBytes: 1000 },
  );
  assert(refused && refused.metric === "terms", "terms shrink refused");
  assert(shrinkDetailCode(refused).startsWith("shrink_guard:terms_"), "shrink code shape");

  const bytes = contextShrinkRefused(
    { terms: 10, examplesTn: 5, examplesTq: 0, templates: 40, contentFiles: 3, totalBytes: 100 },
    { terms: 10, examplesTn: 5, examplesTq: 0, templates: 40, contentFiles: 3, totalBytes: 1000 },
  );
  assert(bytes && bytes.metric === "totalBytes", "bytes shrink refused");

  // Intentional clears (fewer content files) are allowed — the stale file is
  // deleted from the repo instead of the export being refused forever.
  assert(
    !contextShrinkRefused(
      { terms: 10, examplesTn: 5, examplesTq: 0, templates: 40, contentFiles: 2, totalBytes: 950 },
      { terms: 10, examplesTn: 5, examplesTq: 0, templates: 40, contentFiles: 3, totalBytes: 1000 },
    ),
    "content-file drop alone is not refused",
  );

  // Templates shrink guard: mirrors examples (lost > 3 AND lost/previous > 5%).
  const templatesRefused = contextShrinkRefused(
    { terms: 10, examplesTn: 5, examplesTq: 0, templates: 0, contentFiles: 3, totalBytes: 1000 },
    { terms: 10, examplesTn: 5, examplesTq: 0, templates: 40, contentFiles: 3, totalBytes: 1000 },
  );
  assert(templatesRefused && templatesRefused.metric === "templates", "templates 40->0 refused");
  assert(shrinkDetailCode(templatesRefused).startsWith("shrink_guard:templates_"), "templates shrink code shape");
  assert(
    !contextShrinkRefused(
      { terms: 10, examplesTn: 5, examplesTq: 0, templates: 3, contentFiles: 3, totalBytes: 1000 },
      { terms: 10, examplesTn: 5, examplesTq: 0, templates: 4, contentFiles: 3, totalBytes: 1000 },
    ),
    "templates 4->3 not refused (lost <= 3)",
  );
  assert(
    !contextShrinkRefused(
      { terms: 10, examplesTn: 5, examplesTq: 0, templates: 0, contentFiles: 3, totalBytes: 1000 },
      { terms: 10, examplesTn: 5, examplesTq: 0, templates: 0, contentFiles: 3, totalBytes: 1000 },
    ),
    "previous templates 0 never refused",
  );

  assert(
    JSON.stringify(
      stalePackPaths([
        { path: "manifest.yaml", content: "x" },
        { path: "brief.md", content: "x" },
      ]),
    ) ===
      JSON.stringify([
        "instructions.md",
        "terminology/terms.csv",
        "examples/validated.jsonl",
        "templates/templates.tsv",
      ]),
    "stalePackPaths lists omitted pack files only",
  );
  assert(
    stalePackPaths([
      { path: "manifest.yaml", content: "x" },
      { path: "brief.md", content: "x" },
      { path: "instructions.md", content: "x" },
      { path: "terminology/terms.csv", content: "x" },
      { path: "examples/validated.jsonl", content: "x" },
      { path: "templates/templates.tsv", content: "x" },
    ]).length === 0,
    "full pack has no stale paths",
  );
}

console.log("assistedContextRef + owner + tsv truncation");
{
  assert(contextRepoOwner({ DCS_EXPORT_OWNER: "X" }, cfg) === "X", "DCS_EXPORT_OWNER wins");
  assert(contextRepoOwner({}, cfg) === "BSOJ", "fallback to exportOrg");
  // exportOwnerFromConfig makes cfg.exportOrg win over the env fallback — the
  // en-bible-editor-ml-test preset exports to its own org, not the service acct.
  const mlTest = PRESETS["en-bible-editor-ml-test"];
  assert(
    contextRepoOwner({ DCS_EXPORT_OWNER: "BibleEditorService" }, mlTest) === "BibleEditorMLTest",
    "exportOwnerFromConfig: en-bible-editor-ml-test resolves to BibleEditorMLTest (ignores DCS_EXPORT_OWNER)",
  );
  assert(buildContextRef("BSOJ", "abc") === "BSOJ/translation-context@abc", "contextRef shape");

  const latestExport = {
    sha: "deadbeef",
    completedAt: 1,
    owner: "BSOJ",
    terms: 1,
    examplesTn: 0,
    examplesTq: 0,
    templates: 0,
    contentFiles: 1,
    totalBytes: 10,
  };
  const injected = applyContextRef({ sourceRef: "x" }, latestExport);
  assert(injected.contextRef === "BSOJ/translation-context@deadbeef", "injects whenever a successful export exists (no assisted gate)");

  const noSha = applyContextRef({ sourceRef: "x" }, null);
  assert(noSha.contextRef == null, "no inject without successful export");

  const override = applyContextRef({ contextRef: "other/repo@1" }, latestExport);
  assert(override.contextRef === "other/repo@1", "caller override wins");

  assert(tsvLooksTruncated("ID\tNote\n"), "header-only TSV truncated");
  assert(!tsvLooksTruncated("Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\nabcd\tx\t\t\t\t\ty\n"), "normal TSV ok");
}

// Few-shot gold selectors: bulk-approved rows must never become training gold
// (issues #296 / #393). The behaviour is proved end-to-end against the real
// schema in reviewState.test.mjs; this locks the filter into the SQL itself, so
// "tidying" it out fails here too rather than only in the sqlite journey.
console.log("contextExport — validated-example selectors exclude bulk sweeps");
{
  for (const [name, sql] of [
    ["tn", VALIDATED_TN_EXAMPLES_SQL],
    ["tq", VALIDATED_TQ_EXAMPLES_SQL],
  ]) {
    assert(sql.includes("translation_state = 'validated'"), `${name} selector still requires validated`);
    assert(sql.includes("admin_bulk_state IS NULL"), `${name} selector excludes bulk-swept rows (#296/#393)`);
    assert(sql.includes("deleted_at IS NULL"), `${name} selector excludes tombstones`);
  }
  assert(VALIDATED_TN_EXAMPLES_SQL.includes("trashed_at IS NULL"), "tn selector also excludes trashed rows");
}

// #712: the export re-reads D1 after fetching master's tip and renders again
// if anything changed, so an overlapping older run can't publish a pack that
// misses a newer approval. This proves the loader and the comparison against
// the real schema; the workflow loop itself has no node harness.
console.log("contextExport — D1 inputs re-read sees a newer approval");
{
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  const db = {
    prepare: (sql) => ({
      first: async () => sqlite.prepare(sql).get() ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all() }),
    }),
  };
  const unit = sqlite.prepare(
    `INSERT INTO template_units (template_id, support_ref, sheet_order, type, source_md, source_hash, origin, target_md, translation_state, version)
     VALUES (?, ?, ?, '', 'src [text]', 'h', ?, ?, ?, 1)`,
  );
  unit.run("figs-a-01", "figs-a", 1, "sheet", "approved [text]", "validated");
  unit.run("figs-b-01", "figs-b", 2, "sheet", "pending [text]", "edited");
  unit.run("builtin-c", "figs-c", 3, "builtin", "builtin [text]", "validated");
  const tn = sqlite.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, translation_state)
     VALUES (?, 'TIT', 1, 1, '1:1', ?, ?, 1, ?)`,
  );
  tn.run("aa01", "first", 1, "validated");
  tn.run("aa02", "second", 2, "validated");
  tn.run("aa03", "third", 3, "ai_draft");

  const before = await loadContextPackInputs(db);
  assert(before.templates.map((t) => t.template_id).join() === "figs-a-01", "only validated sheet templates with wording load");
  assert(before.tnRows.length === 2 && before.prefs.register === "default", "validated tN rows and default prefs load");
  assert(sameQueuedContextInputs(before, await loadQueuedContextInputs(db)), "an unchanged re-read matches");

  sqlite.prepare(`UPDATE tn_rows SET translation_state = 'validated' WHERE id = 'aa03'`).run();
  assert(
    sameQueuedContextInputs(before, await loadQueuedContextInputs(db)),
    "a tN approval (which queues no export) does not force a re-render",
  );

  sqlite.prepare(`UPDATE template_units SET translation_state = 'validated' WHERE template_id = 'figs-b-01'`).run();
  const afterApprove = await loadQueuedContextInputs(db);
  assert(!sameQueuedContextInputs(before, afterApprove), "a newer template approval is seen as a change");

  const swapped = { ...afterApprove, terms: [{ concept_id: "c", source_term: "s", target_term: "b" }, { concept_id: "c", source_term: "s", target_term: "a" }] };
  const swappedBack = { ...afterApprove, terms: [...swapped.terms].reverse() };
  assert(sameQueuedContextInputs(swapped, swappedBack), "terms tied on their sort keys compare equal in either order");
}

console.log("ALL contextExport tests passed");
