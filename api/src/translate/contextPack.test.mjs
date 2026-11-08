// Context-pack parsing and loading. Ported from the context-pack cases of
// bp-assistant test/translate-core.test.js; the bot's local-directory fixture
// packs become an in-memory fake DCS (the Worker has no filesystem).
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/contextPack.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadContextPack, parseTermsCsv, parseExamplesJsonl, parseTemplatesTsv, parseManifestYaml,
  parseRegisterFromBrief, parseCsvLine, parseContextRef, MAX_PACK_FILE_BYTES, MAX_EXAMPLES_FILE_BYTES,
} from "./contextPack.ts";
import { fakeRawFetch, fixturePackFiles } from "./fixtures.mjs";

const REF = "BSOJ/translation-context@master";

test("parseContextRef accepts org/repo@ref only", () => {
  assert.deepEqual(parseContextRef("BSOJ/translation-context@master"), { org: "BSOJ", repo: "translation-context", ref: "master" });
  assert.deepEqual(parseContextRef(" a/b@deadbeef "), { org: "a", repo: "b", ref: "deadbeef" });
  assert.equal(parseContextRef("C:/some/dir"), null);
  assert.equal(parseContextRef("a/b"), null);
});

test("parseTermsCsv handles 7-col schema, quoting, and status vocab", () => {
  const terms = parseTermsCsv(
    "concept_id,source_term,target_term,status,replacement,comment,tw_link\n"
    + 'kt/grace,"grace, gift",نعمة,preferred,,,\n'
    + "kt/lord,Lord,السيد,forbidden,الرب,no,\n"
    + "n/x,YHWH,,do_not_translate,,,\n");
  assert.equal(terms.length, 3);
  assert.equal(terms[0].source, "grace, gift");
  assert.equal(terms[0].status, "preferred");
  assert.equal(terms[1].status, "forbidden");
  assert.equal(terms[1].replacement, "الرب");
  assert.equal(terms[2].status, "do_not_translate");
  assert.equal(terms[2].target, "");
});

test("parseTermsCsv preserves multiline quoted fields (RFC-4180)", () => {
  const csv = [
    "concept_id,source_term,target_term,status,replacement,comment,tw_link",
    'kt/x,grace,"نعمة',
    'with newline",preferred,,"line1',
    'line2",',
    "kt/y,mercy,رحمة,preferred,,,",
  ].join("\n");
  const terms = parseTermsCsv(csv);
  assert.equal(terms.length, 2);
  assert.equal(terms[0].source, "grace");
  assert.equal(terms[0].target, "نعمة\nwith newline");
  assert.equal(terms[0].status, "preferred");
  assert.equal(terms[0].comment, "line1\nline2");
  assert.equal(terms[1].source, "mercy");
  assert.equal(terms[1].target, "رحمة");
});

test("parseTermsCsv maps legacy statuses and drops unusable rows", () => {
  const terms = parseTermsCsv(
    "concept_id,source_term,target_term,status\n"
    + "a,A,أ,approved\n" // → preferred
    + "b,B,ب,candidate\n" // → admitted
    + "c,C,ج,bogus\n" // unknown status → dropped
    + "d,D,,preferred\n" // preferred without target → dropped
    + "e,,هـ,preferred\n"); // no source → dropped
  assert.deepEqual(terms.map((t) => [t.source, t.status]), [["A", "preferred"], ["B", "admitted"]]);
});

test("parseCsvLine parses one physical line", () => {
  assert.deepEqual(parseCsvLine('a,"b,c",d\n'), ["a", "b,c", "d"]);
});

test("parseTemplatesTsv keeps only active rows", () => {
  const map = parseTemplatesTsv(
    "support_reference\ttarget_template\tstatus\tcomment\n"
    + "figs-metaphor\tok\tactive\t\n"
    + "figs-idiom\tno\tdraft\t\n");
  assert.equal(map.size, 1);
  assert.ok(map.has("figs-metaphor"));
  assert.ok(!map.has("figs-idiom"));
});

test("parseExamplesJsonl applies tombstones last-line-wins", () => {
  const examples = parseExamplesJsonl(
    JSON.stringify({ resource: "tn", rowId: "x", source: "a", target: "b", validated_at: 1 }) + "\n"
    + JSON.stringify({ resource: "tn", rowId: "x", tombstone: true, validated_at: 2 }) + "\n"
    + JSON.stringify({ resource: "tn", rowId: "y", source: "c", target: "d", validated_at: 3 }) + "\n");
  assert.equal(examples.length, 1);
  assert.equal(examples[0].rowId, "y");
});

test("parseManifestYaml / parseRegisterFromBrief cover the scalar subset", () => {
  assert.deepEqual(parseManifestYaml('format: "2"\nlanguage: ar\n'), { format: 2, language: "ar" });
  assert.equal(parseManifestYaml("language: ar\n").format, 1);
  assert.equal(parseRegisterFromBrief("**Register:** Formal"), "formal");
  assert.equal(parseRegisterFromBrief("**Register:** silly"), null);
  assert.equal(parseRegisterFromBrief(null), null);
});

test("loadContextPack loads a fixture pack over fetch", async () => {
  const pack = await loadContextPack(REF, { fetchImpl: fakeRawFetch(fixturePackFiles()) });
  assert.equal(pack.ref, REF);
  assert.equal(pack.sha, null); // branches API 404s in the fake
  assert.equal(pack.templates.get("figs-metaphor").template, "قالب الاستعارة");
  assert.ok(!pack.templates.has("figs-idiom")); // draft inactive
  assert.ok(pack.terms.some((t) => t.status === "preferred" && t.source === "Yahweh"));
  assert.ok(pack.terms.some((t) => t.status === "forbidden"));
  assert.ok(pack.terms.some((t) => t.source === "grace, gift"));
  assert.equal(pack.register, "formal");
  // a1 tombstoned; metaphor examples = c1 only (+ idiom b1)
  assert.equal(pack.examples.length, 2);
  assert.ok(pack.examples.every((e) => e.rowId !== "a1"));
  assert.deepEqual(pack.missing, ["standards.md"]);
  assert.equal(pack.hasContent, true);
});

test("loadContextPack resolves a branch sha and pins a 40-hex ref as-is", async () => {
  const files = fixturePackFiles();
  const withBranches = async (url) => {
    if (/\/api\/v1\/repos\/BSOJ\/translation-context\/branches\/master$/.test(url)) {
      return { status: 200, ok: true, headers: null, text: async () => "", json: async () => ({ commit: { id: "abc123" } }) };
    }
    return fakeRawFetch(files)(url);
  };
  const pack = await loadContextPack(REF, { fetchImpl: withBranches });
  assert.equal(pack.sha, "abc123");
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const pinned = await loadContextPack(`BSOJ/translation-context@${sha}`, { fetchImpl: fakeRawFetch(files) });
  assert.equal(pinned.sha, sha);
});

test("loadContextPack refuses unsupported manifest format", async () => {
  await assert.rejects(
    loadContextPack(REF, { fetchImpl: fakeRawFetch(fixturePackFiles({ format: 99 })) }),
    /format 99 is not supported/,
  );
});

test("loadContextPack throws on a pack with no files present (misconfig guard)", async () => {
  await assert.rejects(loadContextPack(REF, { fetchImpl: fakeRawFetch({}) }), /no content files/);
});

test("loadContextPack throws when only manifest.yaml is present (no content)", async () => {
  await assert.rejects(
    loadContextPack(REF, { fetchImpl: fakeRawFetch({ "manifest.yaml": "format: 1\nlanguage: xx\n" }) }),
    /no content files/,
  );
});

test("loadContextPack with allowEmpty returns hasContent:false instead of throwing", async () => {
  const pack = await loadContextPack(REF, { fetchImpl: fakeRawFetch({}), allowEmpty: true });
  assert.equal(pack.hasContent, false);
  assert.equal(pack.templates.size, 0);
});

test("loadContextPack succeeds when at least one content file is present", async () => {
  const pack = await loadContextPack(REF, { fetchImpl: fakeRawFetch({ "instructions.md": "do the thing" }) });
  assert.equal(pack.instructions, "do the thing");
  assert.ok(pack.missing.includes("manifest.yaml"));
});

test("loadContextPack rejects a non org/repo@ref contextRef (no local-directory branch in the Worker)", async () => {
  await assert.rejects(loadContextPack("C:/tmp/ctx-pack", { fetchImpl: fakeRawFetch({}) }), /contextRef must be "org\/repo@ref"/);
});

test("loadContextPack enforces the byte cap via content-length and via measured UTF-8 bytes", async () => {
  const big = async (url) => ({
    status: 200, ok: true, headers: { get: (h) => (h === "content-length" ? String(MAX_PACK_FILE_BYTES + 1) : null) },
    text: async () => "x", json: async () => ({}),
  });
  await assert.rejects(loadContextPack(REF, { fetchImpl: big }), /file too large/);
  // 2-3 bytes per char: a string under the cap in chars but over it in bytes.
  const arabic = "ن".repeat(Math.ceil(MAX_PACK_FILE_BYTES / 2) + 1);
  const wide = async () => ({ status: 200, ok: true, headers: null, text: async () => arabic, json: async () => ({}) });
  await assert.rejects(loadContextPack(REF, { fetchImpl: wide }), /file too large/);
});

// 2026-11-07: BSOJ's exported validated.jsonl reached 2,413,747 bytes and the
// shared 2 MB cap failed every Arabic translate run. Examples get their own cap.
test("loadContextPack loads a validated.jsonl over the 2 MB general cap, up to the examples cap", async () => {
  const line = JSON.stringify({ resource: "tn", rowId: "x", source: "s", target: "ن".repeat(400) });
  const lines = [];
  // ~800 UTF-8 bytes per line; build to the size of BSOJ's real file.
  for (let i = 0, size = 0; size < 2_413_747; i++) {
    lines.push(line.replace('"x"', `"r${i}"`));
    size += new TextEncoder().encode(lines[i]).length + 1;
  }
  const body = lines.join("\n");
  const bytes = new TextEncoder().encode(body).length;
  assert.ok(bytes > MAX_PACK_FILE_BYTES && bytes < MAX_EXAMPLES_FILE_BYTES);
  const files = { ...fixturePackFiles(), "examples/validated.jsonl": body };
  const inner = fakeRawFetch(files);
  const withLength = async (url) => {
    const res = await inner(url);
    if (!/validated\.jsonl$/.test(url)) return res;
    return { ...res, headers: { get: (h) => (h === "content-length" ? String(bytes) : null) } };
  };
  const pack = await loadContextPack(REF, { fetchImpl: withLength });
  assert.equal(pack.examples.length, lines.length);

  const over = async (url) => {
    const res = await inner(url);
    if (!/validated\.jsonl$/.test(url)) return res;
    return { ...res, headers: { get: (h) => (h === "content-length" ? String(MAX_EXAMPLES_FILE_BYTES + 1) : null) } };
  };
  await assert.rejects(loadContextPack(REF, { fetchImpl: over }), /file too large \(>16000000 bytes\)/);

  // The 2 MB cap still applies to the hand-authored files.
  const bigBrief = fakeRawFetch({ ...fixturePackFiles(), "brief.md": "x".repeat(MAX_PACK_FILE_BYTES + 1) });
  await assert.rejects(loadContextPack(REF, { fetchImpl: bigBrief }), /file too large \(>2000000 bytes\).*brief\.md/);
});

test("loadContextPack surfaces a non-404 HTTP failure", async () => {
  const boom = async () => ({ status: 500, ok: false, headers: null, text: async () => "" });
  await assert.rejects(loadContextPack(REF, { fetchImpl: boom }), /HTTP 500/);
});
