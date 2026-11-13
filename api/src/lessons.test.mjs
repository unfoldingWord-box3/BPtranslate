// Issue #817 part 1: nightly lessons from editor corrections.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/lessons.test.mjs
//
// The REAL job against the REAL migration schema (node:sqlite). The model call
// is a fake Transport; nothing here touches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runNightlyLessons,
  loadLessonsForRender,
  renderLessonsSection,
  readLessonsState,
  setLessonsEnabled,
  mergeLessons,
  parseLessonsOutput,
  isShaddaVowelOnly,
  MAX_LESSONS,
  LESSONS_HEADING,
} from "./lessons.ts";
import { encryptApiKey } from "./aiKeyCrypto.ts";
import { loadContextPackInputs, renderContextPack, renderInstructionsMd } from "./contextExport.ts";
import { contextShrinkRefused } from "./contextExportLib.ts";
import { clearProjectConfigCache } from "./projectConfig.ts";
import { BEGIN_OUTPUT, END_OUTPUT } from "./translate/llm.ts";

const WRAPPING_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const NIGHT1 = Date.UTC(2026, 10, 12, 4, 15) / 1000;
const NIGHT2 = NIGHT1 + 86400;

function makeDb(sqlite) {
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    all() {
      return { results: sqlite.prepare(sql).all(...args), success: true };
    },
    first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    run() {
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      sqlite.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

// Draft/final pairs: يمكنك → فيمكنك in 20 notes across MRK 1 (7), MRK 2 (7) and
// MRK 3 (6), approved chapter by chapter, so the 2-chapter window is MRK 3 + MRK 2
// = 13 notes. Plus, inside the window: 4 notes whose only change is a vowel on a
// shadda (a preference, never a lesson), 2 bulk-approved notes with a different
// change (never read), and 1 approved note with no AI draft (not compared).
async function fresh({ provider = "claude", model = "claude-sonnet-5", enabled = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'admin')`).run();
  sqlite.prepare(`INSERT INTO project_config (id, preset, overrides_json, updated_at) VALUES (1, 'ar-bsoj', NULL, unixepoch())`).run();
  sqlite
    .prepare(`INSERT INTO translation_prefs (id, instructions_md, common_issues_md) VALUES (1, 'Write plainly.', '- «قال» → «يقول»')`)
    .run();
  sqlite
    .prepare(`INSERT INTO terminology (concept_id, source_term, target_term, status) VALUES ('c1', 'grace', 'نعمة', 'preferred')`)
    .run();

  const tn = sqlite.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, support_reference, quote, note, sort_order, version, translation_state, updated_at, admin_bulk_state)
     VALUES (?, 'MRK', ?, 1, ?, 'rc://*/ta/man/translate/figs-metaphor', 'q', ?, 10, 2, 'validated', 1000, ?)`,
  );
  const aiLog = sqlite.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, payload_json)
     VALUES ('tn', ?, 'MRK', NULL, 1, 2, 'update', 'ai_pipeline', ?)`,
  );
  const approve = sqlite.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action) VALUES ('tn', ?, 'MRK', 9, 2, 2, 'validate')`,
  );
  let n = 0;
  const note = (chapter, draft, final, bulk = null) => {
    const id = `r${(n++).toString(36).padStart(3, "0")}`;
    tn.run(id, chapter, `${chapter}:1`, final, bulk);
    if (draft != null) aiLog.run(id, JSON.stringify({ id, note: draft }));
    approve.run(id);
  };
  for (const [chapter, count] of [[1, 7], [2, 7], [3, 6]]) {
    for (let i = 0; i < count; i++) note(chapter, `يمكنك أن تترجم هذا ${chapter}-${i}`, `فيمكنك أن تترجم هذا ${chapter}-${i}`);
    if (chapter >= 2) {
      note(chapter, `قال إنّ الرب ${chapter}`, `قال إنَّ الرب ${chapter}`);
      note(chapter, `قال أنَّ الرب ${chapter}`, `قال أنّ الرب ${chapter}`);
      note(chapter, `كلمة خطأ ${chapter}`, `كلمة صواب ${chapter}`, "approved");
    }
  }
  note(3, null, "ملاحظة بلا مسودة");

  const { ciphertextB64, ivB64 } = await encryptApiKey(WRAPPING_KEY, "sk-ant-api03-notarealkey-000000wxyz");
  sqlite
    .prepare(
      `INSERT INTO ai_provider_config (id, provider, model, key_ciphertext, key_iv, key_hint, version, updated_at)
       VALUES (1, ?, ?, ?, ?, 'wxyz', 1, unixepoch())`,
    )
    .run(provider, model, ciphertextB64, ivB64);

  const slug = `t${Math.random().toString(36).slice(2)}`;
  clearProjectConfigCache(slug);
  const env = { DB: makeDb(sqlite), AI_KEY_WRAPPING_KEY: WRAPPING_KEY, WORKSPACE_SLUG: slug };
  if (enabled) await setLessonsEnabled(env.DB, true, 9);

  const calls = [];
  let reply = null;
  // A fake model that does what the prompt asks: one lesson for the most
  // frequent change it was shown, keeping current lessons by not mentioning them.
  const transport = async (req) => {
    calls.push(req);
    if (reply) return reply(req);
    const m = /^- (\d+)× «([^»]*)» → «([^»]*)»/m.exec(req.user);
    const lessons = m
      ? [{ id: null, lesson: `Start the clause with «${m[3]}», not «${m[2]}».`, before: m[2], after: m[3], evidence: Number(m[1]) }]
      : [];
    return {
      text: `${BEGIN_OUTPUT}\n${JSON.stringify({ lessons, reversed: [] })}\n${END_OUTPUT}`,
      usage: { inputTokens: 4000, outputTokens: 300 },
      stopReason: "end_turn",
    };
  };
  const runs = () => sqlite.prepare(`SELECT * FROM lesson_runs ORDER BY id`).all();
  const approveMore = () => note(3, "يمكنك أن تكتب", "فيمكنك أن تكتب");
  return {
    sqlite,
    env,
    calls,
    runs,
    approveMore,
    setReply: (r) => (reply = r),
    run: (now = NIGHT1) => runNightlyLessons(env, { transport, now }),
  };
}

test("fixture: يمكنك → فيمكنك 20× across 3 chapters becomes a lesson, and instructions.md carries it", async () => {
  const f = await fresh();
  const out = await f.run();
  assert.equal(out.ran, true);
  assert.equal(out.status, "ok");
  assert.equal(f.calls.length, 1, "one AI call");

  // What the model was shown: the 2 most recent chapters, the change with its count there.
  const { system, user } = f.calls[0];
  assert.match(user, /Chapters: MRK 3, MRK 2\./);
  assert.match(user, /^- 13× «يمكنك» → «فيمكنك»/m, "13 of the 20 notes fall in the 2-chapter window");
  assert.doesNotMatch(user, /خطأ|صواب/, "bulk-approved notes are not read");
  assert.doesNotMatch(user, /إنّ|أنّ|إنَّ|أنَّ/, "shadda-vowel-only changes are left out");
  assert.match(user, /- grace → «نعمة»/, "terms are in the input");
  assert.match(user, /Write plainly\./, "instructions are in the input");
  assert.match(user, /«قال» → «يقول»/, "common issues are in the input");
  assert.match(user, /\(none yet\)/, "no current lessons yet");
  assert.match(system, /shadda vowels are a preference, not an error/);
  assert.match(system, new RegExp(`At most ${MAX_LESSONS} lessons`));

  // Stored, priced, and rendered.
  const [run] = f.runs();
  assert.equal(run.status, "ok");
  assert.equal(run.calls, 1);
  assert.equal(run.input_tokens, 4000);
  assert.equal(run.output_tokens, 300);
  assert.ok(Math.abs(run.cost_usd - (4000 * 2 + 300 * 10) / 1e6) < 1e-9, "cost from the price catalog");
  assert.deepEqual(JSON.parse(run.chapters_json), [{ book: "MRK", chapter: 3 }, { book: "MRK", chapter: 2 }]);
  const lessons = await loadLessonsForRender(f.env.DB);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].before, "يمكنك");
  assert.equal(lessons[0].after, "فيمكنك");
  assert.equal(lessons[0].evidence, 13);
  const section = renderLessonsSection(lessons);
  assert.ok(section.startsWith(LESSONS_HEADING));
  assert.match(section, /Example: «يمكنك» → «فيمكنك» \(seen in 13 notes\)/);
  // The export's own loader and renderer put it in instructions.md as the third section.
  const inputs = await loadContextPackInputs(f.env.DB);
  const md = renderInstructionsMd(inputs.prefs, inputs.lessons);
  assert.equal(
    md,
    `Write plainly.\n\n## Common issues\n\n- «قال» → «يقول»\n\n${LESSONS_HEADING}\n\n` +
      "Written automatically each night from what editors changed in recent AI drafts before approving them.\n\n" +
      "- Start the clause with «فيمكنك», not «يمكنك». Example: «يمكنك» → «فيمكنك» (seen in 13 notes)\n",
  );
});

test("switch off (the default): no AI call, no run row, nothing rendered", async () => {
  const f = await fresh({ enabled: false });
  assert.deepEqual(await f.run(), { ran: false, reason: "off" });
  assert.equal(f.calls.length, 0);
  assert.equal(f.runs().length, 0);
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM lesson_settings`).get().n, 0, "no settings row = off");
  const state = await readLessonsState(f.env);
  assert.equal(state.enabled, false);

  // Switched off after a set exists: the set stays stored but is not rendered.
  await setLessonsEnabled(f.env.DB, true, 9);
  await f.run();
  await setLessonsEnabled(f.env.DB, false, 9);
  assert.deepEqual(await loadLessonsForRender(f.env.DB), []);
  assert.equal((await readLessonsState(f.env)).lessons.length, 1);
});

test("a provider without an in-Worker adapter: no call, no run row, and the state says why", async () => {
  const f = await fresh({ provider: "openai", model: "gpt-5.5" });
  const out = await f.run();
  assert.deepEqual(out, { ran: false, reason: "provider_not_supported" });
  assert.equal(f.calls.length, 0);
  assert.equal(f.runs().length, 0);
  const state = await readLessonsState(f.env);
  assert.equal(state.availability.available, false);
  assert.equal(state.availability.reason, "provider_not_supported");
});

test("one call a night, and only when there are new approvals", async () => {
  const f = await fresh();
  await f.run();
  assert.equal((await f.run()).reason, "no_new_approvals", "same night, nothing new");
  f.approveMore();
  assert.equal((await f.run()).reason, "already_ran", "same night, new approval: still one run");
  assert.equal(f.calls.length, 1);
  assert.equal((await f.run(NIGHT2)).status, "ok", "next night picks up the new approval");
  assert.equal(f.calls.length, 2);
  assert.equal((await f.run(NIGHT2 + 86400)).reason, "no_new_approvals");
  assert.equal(f.calls.length, 2);
});

test("current lessons are in the next prompt, and stay when the model does not mention them", async () => {
  const f = await fresh();
  await f.run();
  f.approveMore();
  f.setReply(() => ({
    text: `${BEGIN_OUTPUT}\n{"lessons": [], "reversed": []}\n${END_OUTPUT}`,
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
  }));
  const out = await f.run(NIGHT2);
  assert.equal(out.status, "ok");
  assert.match(f.calls[1].user, /^L1\. Start the clause with «فيمكنك»/m);
  const lessons = await loadLessonsForRender(f.env.DB);
  assert.equal(lessons.length, 1, "a working lesson is not dropped for going quiet");
  assert.equal(lessons[0].firstSeenAt, NIGHT1);
  // Each night's set is its own snapshot.
  assert.equal(f.sqlite.prepare(`SELECT COUNT(DISTINCT run_id) AS n FROM lessons`).get().n, 2);
});

test("an unreadable reply keeps the previous set and still records the cost", async () => {
  const f = await fresh();
  await f.run();
  f.approveMore();
  f.setReply(() => ({ text: "I could not do that.", usage: { inputTokens: 100, outputTokens: 20 }, stopReason: "end_turn" }));
  const out = await f.run(NIGHT2);
  assert.equal(out.status, "failed");
  assert.equal(out.failureReason, "unreadable_output");
  const last = f.runs().at(-1);
  assert.equal(last.status, "failed");
  assert.equal(last.calls, 1);
  assert.ok(last.cost_usd > 0);
  assert.equal((await loadLessonsForRender(f.env.DB)).length, 1);
});

test("a failed AI call is recorded and keeps the previous set", async () => {
  const f = await fresh();
  await f.run();
  f.approveMore();
  f.setReply(() => {
    throw Object.assign(new Error("invalid x-api-key"), { status: 401 });
  });
  const out = await f.run(NIGHT2);
  assert.equal(out.status, "failed");
  assert.equal(out.failureReason, "invalid_key");
  assert.equal(f.runs().at(-1).cost_usd, null, "nothing billed, so no price");
  assert.equal((await loadLessonsForRender(f.env.DB)).length, 1);
});

// ── merge rules (pure) ──────────────────────────────────────────────────────

const L = (lesson, before = "", after = "", evidence = 5, firstSeenAt = 1) => ({ lesson, before, after, evidence, firstSeenAt });
const ctx = { terms: [{ target: "نعمة", replacement: null, status: "preferred" }], templates: ["يمكن أن تترجم هذا بصيغة أخرى"], instructionsMd: "", commonIssuesMd: "" };

test("merge: reversed lessons go, unmentioned ones stay, duplicates of terms/templates are dropped", () => {
  const current = [L("keep me", "أ", "ب"), L("reverse me", "ج", "د"), L("quiet", "ه", "و")];
  const parsed = {
    lessons: [
      { id: "L1", lesson: "keep me, reworded", before: "أ", after: "ب", evidence: 9 },
      { id: "L2", lesson: "should not return", before: "ج", after: "د", evidence: 3 },
      { id: null, lesson: "use the term", before: "فضل", after: "نعمة", evidence: 4 },
      { id: null, lesson: "template words", before: "x", after: "بصيغة أخرى", evidence: 4 },
      { id: null, lesson: "## Heading\nsneaks in", before: "س", after: "ش", evidence: 2 },
      { id: null, lesson: "shadda", before: "إنّ", after: "إنَّ", evidence: 7 },
    ],
    reversed: ["L2"],
  };
  const out = mergeLessons(current, parsed, ctx, 99);
  assert.deepEqual(
    out.map((l) => l.lesson),
    ["keep me, reworded", "Heading sneaks in", "quiet"],
  );
  assert.equal(out[0].evidence, 9);
  assert.equal(out[0].firstSeenAt, 1, "a kept lesson keeps its first-seen date");
  assert.equal(out[1].firstSeenAt, 99);
});

test("merge: never more than the cap, and new lessons give way to current ones", () => {
  const current = Array.from({ length: MAX_LESSONS }, (_, i) => L(`old ${i}`));
  const parsed = { lessons: [{ id: null, lesson: "new one", before: "", after: "", evidence: 50 }], reversed: [] };
  const out = mergeLessons(current, parsed, ctx, 2);
  assert.equal(out.length, MAX_LESSONS);
  assert.ok(!out.some((l) => l.lesson === "new one"));
  const long = mergeLessons([], { lessons: [{ id: null, lesson: "x".repeat(1000), before: "", after: "", evidence: 1 }], reversed: [] }, ctx, 2);
  assert.ok(long[0].lesson.length <= 301);
});

test("parse: needs the agreed JSON object", () => {
  assert.equal(parseLessonsOutput("nothing here"), null);
  assert.equal(parseLessonsOutput(`${BEGIN_OUTPUT}\n{"foo": 1}\n${END_OUTPUT}`), null);
  const p = parseLessonsOutput(`${BEGIN_OUTPUT}\n{"lessons": [{"id": "L1", "lesson": " a\\n b ", "evidence": "4"}], "reversed": ["L3"]}\n${END_OUTPUT}`);
  assert.deepEqual(p, { lessons: [{ id: "L1", lesson: "a b", before: "", after: "", evidence: 4 }], reversed: ["L3"] });
});

test("shadda vowel on either side of the shadda is a preference", () => {
  assert.equal(isShaddaVowelOnly("أنّ", "أنَّ"), true);
  assert.equal(isShaddaVowelOnly("أنّ", "أنّ"), false, "no change at all");
  assert.equal(isShaddaVowelOnly("مفيدا", "مفيدًا"), false, "tanween with no shadda is a real change");
  assert.equal(isShaddaVowelOnly("يمكنك", "فيمكنك"), false);
});

// ── context pack ────────────────────────────────────────────────────────────

const cfg = { languageCode: "ar", languageName: "Arabic", languageTitle: "العربية", direction: "rtl", exportOrg: "BSOJ", org: "BSOJ" };
const prefs = { audience: null, purpose: null, register: "default", script_notes: null, instructions_md: "Be brief.", common_issues_md: null };
const pack = (lessons) =>
  renderContextPack({
    cfg,
    prefs,
    terms: [],
    tnRows: [],
    tqRows: [],
    sources: { tn: new Map(), tq: new Map() },
    templates: [],
    lessons,
    exportedAt: new Date("2026-11-12T04:15:00Z"),
  });

test("context pack: lessons render only when present, and never count toward the shrink guard", () => {
  const off = pack([]);
  const on = pack(Array.from({ length: 25 }, (_, i) => L(`Lesson number ${i} with some words in it.`, "قبل", "بعد", 12)));
  const instr = (r) => r.files.find((f) => f.path === "instructions.md")?.content;
  assert.equal(instr(off), "Be brief.\n");
  assert.ok(instr(on).includes(LESSONS_HEADING));
  assert.equal(on.stats.guardBytes, off.stats.guardBytes, "the lessons section is left out of guardBytes");
  assert.ok(on.stats.totalBytes > off.stats.totalBytes);
  assert.equal(contextShrinkRefused(off.stats, on.stats), null, "switching lessons off never trips the shrink guard");
  // Lessons alone still make an instructions.md.
  const only = renderInstructionsMd({ ...prefs, instructions_md: null }, [L("x")]);
  assert.ok(only.startsWith(LESSONS_HEADING));
});

test("context pack loader: a database without the lesson tables loads no lessons", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql") && f < "0085").sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  const inputs = await loadContextPackInputs(makeDb(sqlite));
  assert.deepEqual(inputs.lessons, []);
  const state = await runNightlyLessons({ DB: makeDb(sqlite), WORKSPACE_SLUG: "x" });
  assert.deepEqual(state, { ran: false, reason: "off" });
});
