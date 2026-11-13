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
  capText,
  buildLessonsPrompt,
  mineChanges,
  nightlyLessonsTick,
  loadCurrentLessons,
  PROMPT_CHAR_CAP,
  RUN_STALE_SECONDS,
  editLesson,
  restoreLessonSet,
  deletedStill,
  appendCommonIssue,
  promotedLine,
} from "./lessons.ts";
import { buildInbox, computeInbox, coveredByLesson } from "./suggestionInbox.ts";
import { runContextExportExclusive, startQueuedContextExport } from "./contextExportQueue.ts";
import { Hono } from "hono";
import { encryptApiKey } from "./aiKeyCrypto.ts";
import { translationMemory } from "./translationMemory.ts";
import { loadContextPackInputs, loadQueuedContextInputs, renderContextPack, renderInstructionsMd } from "./contextExport.ts";
import { contextShrinkRefused } from "./contextExportLib.ts";
import { clearProjectConfigCache } from "./projectConfig.ts";
import { BEGIN_OUTPUT, END_OUTPUT } from "./translate/llm.ts";
import { prefsVersionToSend } from "../../web/src/sync/prefsDraft.ts";

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
    runWith: (now, extra) => runNightlyLessons(env, { transport, now, ...extra }),
    tick: (now = NIGHT1) => nightlyLessonsTick(env, { transport, now }),
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

// ── routes ──────────────────────────────────────────────────────────────────

function appFor(env, role) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", role);
    await next();
  });
  app.route("/api/translation-memory", translationMemory);
  return (path, init) => app.request(path, init, env);
}

test("routes: admin reads the Off default, switches on and off; editors cannot", async () => {
  const f = await fresh({ enabled: false });
  const admin = appFor(f.env, "admin");
  let res = await admin("/api/translation-memory/lessons", { method: "GET" });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.enabled, false);
  assert.equal(body.notMigrated, false);
  assert.equal(body.availability.available, true);
  assert.equal(body.availability.provider, "claude");
  assert.deepEqual(body.lessons, []);
  assert.equal(body.lastRun, null);
  assert.equal(body.maxLessons, MAX_LESSONS);

  const put = (enabled, who = admin) =>
    who("/api/translation-memory/lessons", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
  res = await put(true);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).enabled, true);
  await f.run();
  body = await (await admin("/api/translation-memory/lessons", { method: "GET" })).json();
  assert.equal(body.lessons.length, 1);
  assert.equal(body.lessons[0].evidence, 13);
  assert.equal(body.lastRun.status, "ok");
  assert.ok(body.lastRun.costUsd > 0);
  assert.equal(body.setAt != null, true);

  res = await put(false);
  assert.equal((await res.json()).enabled, false);
  assert.equal((await put("yes")).status, 400);

  const editor = appFor(f.env, "editor");
  assert.equal((await editor("/api/translation-memory/lessons", { method: "GET" })).status, 403);
  assert.equal((await put(true, editor)).status, 403);
});

// ── review round (#817) ─────────────────────────────────────────────────────

test("a failed run does not advance the watermark: the next night mines the same approvals again", async () => {
  const f = await fresh();
  f.setReply(() => ({ text: "garbage", usage: { inputTokens: 100, outputTokens: 20 }, stopReason: "end_turn" }));
  assert.equal((await f.run()).status, "failed");
  f.setReply(null);
  const out = await f.run(NIGHT2);
  assert.equal(out.status, "ok", "no new approval, but the failed night's corrections are retried");
  assert.equal(f.calls.length, 2);
  assert.equal((await f.run(NIGHT2 + 86400)).reason, "no_new_approvals", "a successful run does advance it");
});

test("a run killed mid-way (row left 'running') is marked failed by the next night's run", async () => {
  const f = await fresh();
  f.sqlite
    .prepare(`INSERT INTO lesson_runs (night, started_at, approvals_through, status) VALUES ('2026-11-01', 1, 999999, 'running')`)
    .run();
  const out = await f.run();
  assert.equal(out.status, "ok", "the dead run's watermark does not block tonight");
  const dead = f.sqlite.prepare(`SELECT status, failure_reason, finished_at FROM lesson_runs WHERE night = '2026-11-01'`).get();
  assert.equal(dead.status, "failed");
  assert.equal(dead.failure_reason, "interrupted");
  assert.ok(dead.finished_at > 0);
});

test("the outcome says whether the stored set changed", async () => {
  const f = await fresh();
  assert.equal((await f.run()).changed, true);
  f.approveMore();
  const same = f.calls.length;
  f.setReply(() => ({
    text: `${BEGIN_OUTPUT}\n{"lessons": [], "reversed": []}\n${END_OUTPUT}`,
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
  }));
  const out = await f.run(NIGHT2);
  assert.equal(f.calls.length, same + 1);
  assert.equal(out.status, "ok");
  assert.equal(out.changed, false, "same lessons kept: nothing new to export");
});

test("evidence is clamped to the notes compared in the run", async () => {
  const f = await fresh();
  f.setReply(() => ({
    text: `${BEGIN_OUTPUT}\n{"lessons": [{"id": null, "lesson": "Big claim.", "before": "a", "after": "b", "evidence": 1e300}], "reversed": []}\n${END_OUTPUT}`,
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
  }));
  await f.run();
  const [l] = await loadLessonsForRender(f.env.DB);
  // Notes compared in MRK 2–3: 7 + 6 يمكنك notes and 4 shadda notes; the
  // bulk-approved and no-draft notes are not compared.
  assert.equal(l.evidence, 17);
  assert.doesNotMatch(renderLessonsSection([l]), /e\+/);
});

test("PUT on is refused (409) when lessons cannot run; off is always allowed; page and night job agree", async () => {
  const f = await fresh({ provider: "openai", model: "gpt-5.5", enabled: false });
  const admin = appFor(f.env, "admin");
  const put = (enabled) =>
    admin("/api/translation-memory/lessons", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
  let res = await put(true);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "lessons_unavailable", reason: "provider_not_supported" });
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM lesson_settings WHERE enabled = 1`).get().n, 0);
  assert.equal((await put(false)).status, 200);

  // A key that no longer decrypts (wrapping key rotated): the page says so, PUT refuses, the job does not call.
  const g = await fresh({ enabled: false });
  g.env.AI_KEY_WRAPPING_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const admin2 = appFor(g.env, "admin");
  const state = await (await admin2("/api/translation-memory/lessons", { method: "GET" })).json();
  assert.equal(state.availability.available, false);
  assert.equal(state.availability.reason, "ai_provider_key_decrypt_failed");
  res = await admin2("/api/translation-memory/lessons", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
  assert.equal(res.status, 409);
  await setLessonsEnabled(g.env.DB, true, 9);
  assert.deepEqual(await g.run(), { ran: false, reason: "ai_provider_key_decrypt_failed" });
  assert.equal(g.calls.length, 0);
});

test("shadda: only a vowel present on one side and absent on the other is a preference", () => {
  assert.equal(isShaddaVowelOnly("إنَّ", "إنّ"), true, "vowel dropped");
  assert.equal(isShaddaVowelOnly("ربّ", "ربُّ"), true, "vowel added");
  assert.equal(isShaddaVowelOnly("الربُّ", "الربَّ"), false, "damma → fatha on the shadda is a grammar fix");
  assert.equal(isShaddaVowelOnly("عدوٌّ", "عدوًّ"), false, "tanween swap on the shadda is a real change");
  assert.equal(isShaddaVowelOnly("أنَّ قال", "أنّ يقول"), false, "another word changed too");
});

test("capText counts code points and never splits a letter from its marks", () => {
  assert.equal(capText("abc", 5), "abc");
  assert.equal(capText("abcdef", 3), "abc…");
  const marked = "بَّ".repeat(10); // 3 code points each: letter + two marks
  assert.equal(capText(marked, 4), "بَّ…");
  assert.equal(capText(marked, 6), "بَّبَّ…");
  assert.equal(capText("😀".repeat(5), 2), "😀😀…", "no lone surrogate");
});

test("a killed run is closed even on a night with nothing new to mine", async () => {
  const f = await fresh();
  await f.run();
  f.sqlite.prepare(`INSERT INTO lesson_runs (night, started_at, approvals_through, status) VALUES ('2026-11-12b', 1, 0, 'running')`).run();
  assert.equal((await f.run(NIGHT2)).reason, "no_new_approvals");
  assert.equal(f.sqlite.prepare(`SELECT status FROM lesson_runs WHERE night = '2026-11-12b'`).get().status, "failed");
});

// ── review round 2 (#817) ───────────────────────────────────────────────────

// Long rewrites (no shared word) cost the diff n×m cells each. Enough of them
// used to spend the whole run's shared cell budget, after which every later
// note counted as compared but yielded no changes.
function addRewrites(f, chapter, count) {
  const tn = f.sqlite.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, support_reference, quote, note, sort_order, version, translation_state, updated_at)
     VALUES (?, 'MRK', ?, 1, ?, 'x', 'q', ?, 10, 2, 'validated', 1000)`,
  );
  const ai = f.sqlite.prepare(
    `INSERT INTO edit_log (kind, row_key, book, prev_version, new_version, action, source, payload_json)
     VALUES ('tn', ?, 'MRK', 1, 2, 'update', 'ai_pipeline', ?)`,
  );
  const draft = Array.from({ length: 400 }, (_, i) => `d${i}`).join(" ");
  const final = Array.from({ length: 400 }, (_, i) => `f${i}`).join(" ");
  f.sqlite.exec("BEGIN");
  for (let i = 0; i < count; i++) {
    const id = `b${i.toString(36).padStart(4, "0")}`;
    tn.run(id, chapter, `${chapter}:1`, final);
    ai.run(id, JSON.stringify({ id, note: draft }));
  }
  f.sqlite.exec("COMMIT");
}

test("every note gets its own diff budget: long rewrites early in the window do not hide later corrections", async () => {
  const f = await fresh();
  addRewrites(f, 3, 1900); // 1900 × 160,000 cells > the old shared 300,000,000
  await f.run();
  assert.match(f.calls[0].user, /^- 13× «يمكنك» → «فيمكنك»/m);
});

test("two books with the same chapter number are mined apart", async () => {
  const f = await fresh();
  // TIT 3 approved last: the window becomes TIT 3 + MRK 3, never MRK 3 twice.
  f.sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, support_reference, quote, note, sort_order, version, translation_state, updated_at)
       VALUES ('t001', 'TIT', 3, 1, '3:1', 'x', 'q', 'كتب الرسول', 10, 2, 'validated', 1000)`,
    )
    .run();
  f.sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, prev_version, new_version, action, source, payload_json)
       VALUES ('tn', 't001', 'TIT', 1, 2, 'update', 'ai_pipeline', '{"note": "قال الرسول"}')`,
    )
    .run();
  f.sqlite.prepare(`INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action) VALUES ('tn', 't001', 'TIT', 9, 2, 2, 'validate')`).run();
  await f.run();
  const { user } = f.calls[0];
  assert.match(user, /Chapters: TIT 3, MRK 3\./);
  assert.match(user, /^- 6× «يمكنك» → «فيمكنك»/m, "MRK 3 only: TIT 3 has no يمكنك notes");
  assert.match(user, /^- 1× «قال» → «كتب»/m);
});

test("a truncated reply is one billed call: no lower-effort retry, previous set kept", async () => {
  const f = await fresh();
  await f.run();
  f.approveMore();
  f.setReply(() => ({ text: `${BEGIN_OUTPUT}\n{"lessons": [`, usage: { inputTokens: 100, outputTokens: 32000 }, stopReason: "max_tokens" }));
  const out = await f.run(NIGHT2);
  assert.equal(f.calls.length, 2, "one call tonight, no retry");
  assert.equal(out.status, "failed");
  assert.equal(out.failureReason, "output_too_long");
  assert.equal(f.runs().at(-1).calls, 1);
  assert.ok(f.runs().at(-1).cost_usd > 0);
  assert.equal((await loadLessonsForRender(f.env.DB)).length, 1);
});

// ── review round 3 (#817) ───────────────────────────────────────────────────

// The window's drafted, hand-approved notes, by approval (edit_log id), oldest first.
function windowApprovals(f) {
  return f.sqlite
    .prepare(
      `SELECT MAX(e.id) AS id FROM edit_log e JOIN tn_rows t ON t.id = e.row_key AND t.book = e.book
        WHERE e.action = 'validate' AND t.chapter IN (2, 3) AND t.admin_bulk_state IS NULL
          AND EXISTS (SELECT 1 FROM edit_log d WHERE d.row_key = t.id AND d.source = 'ai_pipeline')
        GROUP BY t.id ORDER BY id`,
    )
    .all()
    .map((r) => r.id);
}

test("the mining budget stops a run without skipping approvals: the next night resumes where it stopped", async () => {
  const f = await fresh();
  const approvals = windowApprovals(f);
  const newest = f.sqlite.prepare(`SELECT MAX(id) AS w FROM edit_log WHERE action = 'validate'`).get().w;
  // A budget of one cell: each night diffs exactly one note (the one that crosses the line finishes).
  const out1 = await f.runWith(NIGHT1, { cells: 1 });
  assert.equal(out1.status, "ok");
  assert.equal(out1.truncated, true);
  assert.match(f.calls[0].user, /compared with their AI draft: 1;/);
  assert.equal(f.runs().at(-1).approvals_through, approvals[1] - 1, "the watermark stops below the first approval left");

  const out2 = await f.runWith(NIGHT2, { cells: 1 });
  assert.equal(out2.ran, true, "no new approval, but the stopped run's rest is still due");
  assert.equal(f.runs().at(-1).approvals_through, approvals[2] - 1, "the next night diffs the next approval");

  const out3 = await f.run(NIGHT2 + 86400);
  assert.equal(out3.truncated, false);
  assert.equal(f.runs().at(-1).approvals_through, newest, "a run that diffs everything takes the full watermark");
  assert.equal((await f.run(NIGHT2 + 2 * 86400)).reason, "no_new_approvals");
});

test("the run-wide budget bounds the diff work of many long rewrites", async () => {
  const f = await fresh();
  addRewrites(f, 3, 400); // 400 × 160,000 cells = 64M > MINING_CELL_BUDGET
  const mined = await mineChanges(f.env.DB, [{ book: "MRK", chapter: 3 }]);
  assert.equal(mined.truncated, true);
  assert.equal(mined.stoppedAt, null, "every new approval was diffed before the rewrites (which have none)");
  assert.ok(mined.compared < 400, `compared ${mined.compared}`);
  assert.equal(mined.groups[0].before, "يمكنك", "approved corrections come first");
});

test("every prompt string is capped, and the whole prompt stays under PROMPT_CHAR_CAP with true counts", () => {
  const huge = "x".repeat(10_000);
  const { system, user } = buildLessonsPrompt({
    languageName: huge,
    languageCode: huge,
    current: [{ lesson: huge, before: huge, after: huge, evidence: 3, firstSeenAt: 1 }],
    instructionsMd: huge,
    commonIssuesMd: huge,
    terms: Array.from({ length: 300 }, (_, i) => ({ source: `${huge}${i}`, target: huge, status: i % 2 ? "forbidden" : huge, replacement: huge })),
    chapters: [{ book: huge, chapter: 1 }],
    compared: 60,
    changed: 60,
    groups: Array.from({ length: 70 }, (_, i) => ({ before: huge, after: `${huge}${i}`, count: 70 - i, draftExcerpt: huge, finalExcerpt: huge })),
  });
  assert.ok(system.length < 5_000, `system ${system.length}`);
  assert.ok(user.length <= PROMPT_CHAR_CAP, `user ${user.length}`);
  const lines = user.split("\n");
  // Only the two capped preference texts may be long single lines.
  assert.equal(lines.filter((l) => l.length > 1_000).length, 2);
  const changeLines = lines.filter((l) => /^- \d+× /.test(l));
  assert.equal(changeLines.length, 60, "changes go in before terms (60 = MAX_PROMPT_CHANGES)");
  assert.match(user, /\(10 rarer changes not shown\)/);
  const termLines = lines.filter((l) => /^- x{100}/.test(l));
  assert.ok(termLines.length > 0 && termLines.length < 300);
  assert.match(user, new RegExp(`\\(${300 - termLines.length} more terms not shown\\)`));
});

test("a long term or token in the database never reaches the provider uncapped", async () => {
  const f = await fresh();
  const long = "ب".repeat(10_000);
  f.sqlite.prepare(`INSERT INTO terminology (concept_id, source_term, target_term, status) VALUES ('c2', ?, ?, 'preferred')`).run(long, long);
  f.approveMore();
  f.sqlite.prepare(`UPDATE tn_rows SET note = ? WHERE id = (SELECT MAX(id) FROM tn_rows WHERE chapter = 3 AND id LIKE 'r%')`).run(`فيمكنك ${long}`);
  await f.run();
  assert.ok(f.calls[0].user.length <= PROMPT_CHAR_CAP);
  assert.ok(!f.calls[0].user.includes("ب".repeat(500)));
});

test("a changed set stored while tonight's export holds the lease reaches that export's follow-up", async () => {
  const f = await fresh();
  const created = [];
  f.env.DCS_SERVICE_TOKEN = "service-token";
  f.env.EXPORT_WORKFLOW = { create: async (o) => (created.push(o), { id: o.id }) };
  const key = f.env.WORKSPACE_SLUG;
  let inputsRead;
  await runContextExportExclusive({
    db: f.env.DB,
    key,
    instance: "context-nightly",
    markPending: true,
    shrinkOverride: false,
    run: async () => {
      // The running export read its inputs before tonight's lessons were written.
      inputsRead = await loadQueuedContextInputs(f.env.DB);
      await f.tick();
      assert.equal(created.length, 0, "the lease is held: no second export starts");
      return { status: "ok", failureReason: null };
    },
    startFollowUp: () => startQueuedContextExport(f.env),
  });
  assert.deepEqual(inputsRead.lessons, []);
  assert.equal(created.length, 1, "exactly one follow-up");
  assert.equal(created[0].params.queued, true);
  const followUp = await loadQueuedContextInputs(f.env.DB);
  assert.equal(followUp.lessons.length, 1);
  assert.match(renderInstructionsMd(followUp.prefs, followUp.lessons), new RegExp(LESSONS_HEADING));

  // An unchanged night requests nothing.
  f.sqlite.prepare(`UPDATE context_export_lock SET pending = 0`).run();
  await f.tick(NIGHT2);
  assert.equal(created.length, 1);
  assert.equal(f.sqlite.prepare(`SELECT pending FROM context_export_lock`).get().pending, 0);
});

test("PUT answers only after the context export is marked pending", async () => {
  const f = await fresh({ enabled: false });
  let release;
  const gate = new Promise((r) => (release = r));
  const gated = (st) => ({
    bind: (...a) => gated(st.bind(...a)),
    first: async () => (await gate, st.first()),
    run: async () => (await gate, st.run()),
    all: async () => (await gate, st.all()),
  });
  const db = f.env.DB;
  const created = [];
  const env = {
    ...f.env,
    DB: { ...db, prepare: (sql) => (/context_export_lock/.test(sql) ? gated(db.prepare(sql)) : db.prepare(sql)) },
    DCS_SERVICE_TOKEN: "service-token",
    EXPORT_WORKFLOW: { create: async (o) => (created.push(o), { id: o.id }) },
  };
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "admin");
    await next();
  });
  app.route("/api/translation-memory", translationMemory);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  let answered = false;
  const res = app
    .request(
      "/api/translation-memory/lessons",
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) },
      env,
      ctx,
    )
    .then((r) => ((answered = true), r));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(answered, false, "no answer while the export is not yet marked pending");
  release();
  assert.equal((await res).status, 200);
  assert.equal(f.sqlite.prepare(`SELECT pending FROM context_export_lock`).get().pending, 1);
  assert.equal(created.length, 1);
});

test("a run killed earlier tonight is retried tonight once stale; a run that ended is not", async () => {
  const f = await fresh();
  f.sqlite
    .prepare(`INSERT INTO lesson_runs (night, started_at, approvals_through, status) VALUES ('2026-11-12', ?, 0, 'running')`)
    .run(NIGHT1 - 600);
  assert.equal((await f.run()).reason, "already_ran", "ten minutes old: it may still be running");
  assert.equal(f.calls.length, 0);
  const out = await f.run(NIGHT1 - 600 + RUN_STALE_SECONDS);
  assert.equal(out.status, "ok", "stale: closed as interrupted and taken over the same night");
  assert.equal(f.calls.length, 1);
  assert.equal(f.runs().length, 1);
  assert.equal(f.runs()[0].status, "ok");

  const g = await fresh();
  g.setReply(() => ({ text: "garbage", usage: { inputTokens: 100, outputTokens: 20 }, stopReason: "end_turn" }));
  assert.equal((await g.run()).status, "failed");
  g.setReply(null);
  assert.equal((await g.run(NIGHT1 + RUN_STALE_SECONDS + 60)).reason, "already_ran", "one call a night for a failing provider");
  assert.equal(g.calls.length, 1);
});

test("a new evidence count alone is not a changed set (no pack export), but it is stored", async () => {
  const f = await fresh();
  assert.equal((await f.run()).changed, true);
  const [l] = (await loadCurrentLessons(f.env.DB)).lessons;
  f.approveMore();
  f.setReply(() => ({
    text: `${BEGIN_OUTPUT}\n${JSON.stringify({ lessons: [{ id: "L1", lesson: l.lesson, before: l.before, after: l.after, evidence: l.evidence - 2 }], reversed: [] })}\n${END_OUTPUT}`,
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
  }));
  const out = await f.run(NIGHT2);
  assert.equal(out.status, "ok");
  assert.equal(out.changed, false);
  assert.equal((await loadCurrentLessons(f.env.DB)).lessons[0].evidence, l.evidence - 2);
});

// ── review round 4 (#817) ───────────────────────────────────────────────────

// One hand-approved AI-drafted note in MRK `chapter`, approved now. Returns the approval's edit_log id.
function approveIn(f, chapter, id, draft = "يمكنك أن تكتب", final = "فيمكنك أن تكتب") {
  f.sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, support_reference, quote, note, sort_order, version, translation_state, updated_at)
       VALUES (?, 'MRK', ?, 1, ?, 'x', 'q', ?, 10, 2, 'validated', 1000)`,
    )
    .run(id, chapter, `${chapter}:1`, final);
  f.sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, prev_version, new_version, action, source, payload_json)
       VALUES ('tn', ?, 'MRK', 1, 2, 'update', 'ai_pipeline', ?)`,
    )
    .run(id, JSON.stringify({ id, note: draft }));
  const r = f.sqlite
    .prepare(`INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action) VALUES ('tn', ?, 'MRK', 9, 2, 2, 'validate')`)
    .run(id);
  return Number(r.lastInsertRowid);
}

test("a run stopped by the budget is finished the next night even when editors moved to another chapter", async () => {
  const f = await fresh();
  const approvals = windowApprovals(f); // MRK 2 + MRK 3, oldest first
  await f.runWith(NIGHT1, { cells: 1 });
  assert.equal(f.runs().at(-1).approvals_through, approvals[1] - 1);
  // Before night 2, editors approve in MRK 4: the newest window is now MRK 4 + MRK 3, without MRK 2.
  const c4 = approveIn(f, 4, "c401");
  const out2 = await f.run(NIGHT2);
  assert.equal(out2.status, "ok");
  assert.match(f.calls[1].user, /Chapters: MRK 3, MRK 2\./, "night 2 finishes the stopped run's chapters");
  // Every drafted note of MRK 2–3 is compared (13 يمكنك + 4 shadda notes).
  assert.match(f.calls[1].user, /compared with their AI draft: 17;/);
  assert.ok(f.runs().at(-1).approvals_through < c4, "MRK 4's approval was not mined, so the watermark stays below it");
  const out3 = await f.run(NIGHT2 + 86400);
  assert.equal(out3.status, "ok", "night 3 mines the newest window");
  assert.match(f.calls[2].user, /Chapters: MRK 4, MRK 3\./);
  assert.equal(f.runs().at(-1).approvals_through, c4);
  assert.equal((await f.run(NIGHT2 + 2 * 86400)).reason, "no_new_approvals");
});

test("a finished resume whose chapters are still the newest takes the full watermark", async () => {
  const f = await fresh();
  await f.runWith(NIGHT1, { cells: 1 });
  assert.equal((await f.run(NIGHT2)).status, "ok");
  assert.equal((await f.run(NIGHT2 + 86400)).reason, "no_new_approvals", "no extra night");
});

test("a killed run is closed as interrupted even after lessons are switched off", async () => {
  const f = await fresh();
  f.sqlite.prepare(`INSERT INTO lesson_runs (night, started_at, approvals_through, status) VALUES ('2026-11-11', 1, 0, 'running')`).run();
  await setLessonsEnabled(f.env.DB, false, 9);
  assert.deepEqual(await f.run(), { ran: false, reason: "off" });
  const row = f.sqlite.prepare(`SELECT status, failure_reason FROM lesson_runs WHERE night = '2026-11-11'`).get();
  assert.equal(row.status, "failed");
  assert.equal(row.failure_reason, "interrupted");
});

for (const evidence of [null, "", 40]) {
  test(`evidence ${JSON.stringify(evidence)} on a kept lesson, on a night that compares one note, keeps its count`, async () => {
    const f = await fresh();
    await f.run();
    const [l] = (await loadCurrentLessons(f.env.DB)).lessons;
    assert.equal(l.evidence, 13);
    approveIn(f, 3, "e301");
    f.setReply(() => ({
      text: `${BEGIN_OUTPUT}\n${JSON.stringify({ lessons: [{ id: "L1", lesson: l.lesson, before: l.before, after: l.after, evidence }], reversed: [] })}\n${END_OUTPUT}`,
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "end_turn",
    }));
    const out = await f.runWith(NIGHT2, { cells: 1 });
    assert.equal(out.status, "ok");
    assert.match(f.calls[1].user, /compared with their AI draft: 1;/);
    assert.equal((await loadCurrentLessons(f.env.DB)).lessons[0].evidence, 13);
  });
}

test("a call that throws before any usage comes back still counts as a call", async () => {
  const f = await fresh();
  f.setReply(() => {
    throw new Error("network down");
  });
  const out = await f.run();
  assert.equal(out.status, "failed");
  const row = f.runs().at(-1);
  assert.equal(row.calls, 1, "the page must not say no call was made");
  assert.equal(row.cost_usd, null);
});

// ── part 2 (#908): delete, pin, promote, restore; coveredByLesson; leftovers ──

const NIGHT3 = NIGHT2 + 86400;
const NIGHT4 = NIGHT3 + 86400;
const THREE = [
  { id: null, lesson: "Start with «فيمكنك».", before: "يمكنك", after: "فيمكنك", evidence: 5 },
  { id: null, lesson: "Say «ذلك» here.", before: "هذا", after: "ذلك", evidence: 3 },
  { id: null, lesson: "Use «لكي» for purpose.", before: "أن", after: "لكي", evidence: 2 },
];
const replyWith = (lessons, reversed = []) => () => ({
  text: `${BEGIN_OUTPUT}\n${JSON.stringify({ lessons, reversed })}\n${END_OUTPUT}`,
  usage: { inputTokens: 10, outputTokens: 5 },
  stopReason: "end_turn",
});
// One more hand-approved note in MRK 4 with an unrelated change.
function approveOther(f, tag) {
  const id = `z${tag}`;
  f.sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, support_reference, quote, note, sort_order, version, translation_state, updated_at)
       VALUES (?, 'MRK', 4, 1, '4:1', 'rc://*/ta/man/translate/figs-metaphor', 'q', ?, 10, 2, 'validated', 1000)`,
    )
    .run(id, `كلام آخر ${tag}`);
  f.sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, payload_json)
       VALUES ('tn', ?, 'MRK', NULL, 1, 2, 'update', 'ai_pipeline', ?)`,
    )
    .run(id, JSON.stringify({ id, note: `قول آخر ${tag}` }));
  f.sqlite
    .prepare(`INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action) VALUES ('tn', ?, 'MRK', 9, 2, 2, 'validate')`)
    .run(id);
}

async function withThree() {
  const f = await fresh();
  f.setReply(replyWith(THREE));
  assert.equal((await f.run()).status, "ok");
  f.setReply(null);
  return f;
}

test("routes (#908): admin pins, deletes, promotes and restores; each is a new set and the last run stays the night's", async () => {
  const f = await withThree();
  const admin = appFor(f.env, "admin");
  const post = (path, body, who = admin) =>
    who(`/api/translation-memory/lessons/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  let state = await (await admin("/api/translation-memory/lessons", { method: "GET" })).json();
  const s1 = state.setId;
  assert.equal(state.lessons.length, 3);
  assert.deepEqual(state.sets.map((s) => [s.kind, s.count]), [["night", 3]]);

  // Pin the second lesson.
  let res = await post("edit", { setId: s1, position: 2, action: "pin" });
  assert.equal(res.status, 200);
  state = await res.json();
  assert.notEqual(state.setId, s1, "a pin writes a new set");
  assert.deepEqual(state.lessons.map((l) => l.pinned), [false, true, false]);
  assert.equal(state.lastRun.status, "ok", "an admin change is not shown as the last run");
  assert.equal(state.lastRun.id, s1);
  assert.deepEqual(state.sets.map((s) => [s.kind, s.action, s.count]), [["edit", "pin", 3], ["night", null, 3]]);

  // The old set id is stale now.
  res = await post("edit", { setId: s1, position: 1, action: "delete" });
  assert.equal(res.status, 409);
  const stale = await res.json();
  assert.equal(stale.error, "stale_set");
  assert.equal(stale.state.setId, state.setId, "the refusal carries the fresh state");

  // Delete the first lesson.
  res = await post("edit", { setId: state.setId, position: 1, action: "delete" });
  assert.equal(res.status, 200);
  state = await res.json();
  assert.deepEqual(state.lessons.map((l) => l.lesson), ["Say «ذلك» here.", "Use «لكي» for purpose."]);
  assert.equal(state.lessons[0].pinned, true, "the pin survives the next change");
  const del = f.sqlite.prepare(`SELECT * FROM lesson_deletions`).all();
  assert.equal(del.length, 1);
  assert.equal(del[0].example_before, "يمكنك");
  assert.ok(del[0].approvals_through > 0);

  // Promote the last lesson to Common issues.
  const v0 = f.sqlite.prepare(`SELECT version FROM translation_prefs WHERE id = 1`).get().version;
  res = await post("edit", { setId: state.setId, position: 2, action: "promote" });
  assert.equal(res.status, 200);
  state = await res.json();
  assert.deepEqual(state.lessons.map((l) => l.lesson), ["Say «ذلك» here."]);
  assert.equal(state.prefs.common_issues_md, "- «قال» → «يقول»\n- Use «لكي» for purpose. Example: «أن» → «لكي»");
  assert.equal(state.prefs.version, v0 + 1, "a prefs save: the version moves, so an open editor cannot overwrite it");
  const hist = f.sqlite.prepare(`SELECT * FROM edit_log WHERE kind = 'prefs' ORDER BY id DESC LIMIT 1`).get();
  assert.equal(hist.prev_version, v0);
  assert.equal(hist.new_version, v0 + 1);
  assert.equal(JSON.parse(hist.payload_json).changed.common_issues_md.new, state.prefs.common_issues_md);

  // Restore the night's set: a new set, history untouched.
  res = await post("restore", { setId: s1, currentSetId: state.setId });
  assert.equal(res.status, 200);
  state = await res.json();
  assert.deepEqual(state.lessons.map((l) => l.lesson), THREE.map((l) => l.lesson));
  assert.deepEqual(state.lessons.map((l) => l.pinned), [false, false, false], "a restored set comes back as it was stored");
  assert.deepEqual(state.sets.map((s) => s.action), ["restore", "promote", "delete", "pin", null]);
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM lessons WHERE run_id = ?`).get(s1).n, 3, "the night's set is never rewritten");
  assert.equal((await loadLessonsForRender(f.env.DB)).length, 3, "the pack renders the restored set");
  assert.equal((await post("restore", { setId: state.setId, currentSetId: state.setId })).status, 400);
  assert.equal((await post("restore", { setId: 999, currentSetId: state.setId })).status, 404);
  assert.equal((await post("edit", { setId: state.setId, position: 9, action: "pin" })).status, 404);
  assert.equal((await post("edit", { setId: state.setId, position: 1, action: "rename" })).status, 400);

  // Editors get 403 on every lessons route.
  const editor = appFor(f.env, "editor");
  assert.equal((await post("edit", { setId: state.setId, position: 1, action: "delete" }, editor)).status, 403);
  assert.equal((await post("restore", { setId: s1, currentSetId: state.setId }, editor)).status, 403);
  assert.equal((await loadCurrentLessons(f.env.DB)).runId, state.setId, "nothing changed");
});

test("an admin change answers only after the context export is marked pending (#908)", async () => {
  const f = await withThree();
  const created = [];
  const env = { ...f.env, DCS_SERVICE_TOKEN: "service-token", EXPORT_WORKFLOW: { create: async (o) => (created.push(o), { id: o.id }) } };
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "admin");
    await next();
  });
  app.route("/api/translation-memory", translationMemory);
  const { runId: setId } = await loadCurrentLessons(f.env.DB);
  const res = await app.request(
    "/api/translation-memory/lessons/edit",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setId, position: 1, action: "delete" }) },
    env,
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(res.status, 200);
  assert.equal(created.length, 1, "the export was started before the answer");
});

test("no admin change lands while a nightly run is in progress; a killed run does not block (#908)", async () => {
  const f = await withThree();
  const { runId } = await loadCurrentLessons(f.env.DB);
  const now = NIGHT2;
  f.sqlite.prepare(`INSERT INTO lesson_runs (night, started_at, status, approvals_through) VALUES ('2026-11-13', ?, 'running', 1)`).run(now - 60);
  let out = await editLesson(f.env, { setId: runId, position: 1, action: "delete", userId: 9, now });
  assert.deepEqual(out, { ok: false, status: 409, error: "run_in_progress" });
  assert.equal((await loadCurrentLessons(f.env.DB)).runId, runId);
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM lesson_deletions`).get().n, 0, "nothing of the change landed");
  out = await editLesson(f.env, { setId: runId, position: 1, action: "delete", userId: 9, now: now + RUN_STALE_SECONDS + 1 });
  assert.equal(out.ok, true);
});

test("a pinned lesson survives the night: the model cannot reverse, reword or crowd it out (#908)", async () => {
  const f = await withThree();
  const { runId } = await loadCurrentLessons(f.env.DB);
  assert.equal((await editLesson(f.env, { setId: runId, position: 3, action: "pin", userId: 9, now: NIGHT1 + 60 })).ok, true);
  f.approveMore();
  // The model rewords L3 (the pinned one) under its id and reverses L1.
  f.setReply(replyWith([{ id: "L3", lesson: "Never use «لكي».", before: "لكي", after: "أن", evidence: 9 }, { id: "L2", lesson: "Say «ذلك».", before: "هذا", after: "ذلك", evidence: 4 }], ["L1"]));
  assert.equal((await f.run(NIGHT2)).status, "ok");
  const after = (await loadCurrentLessons(f.env.DB)).lessons;
  assert.deepEqual(after.map((l) => [l.lesson, l.pinned]), [["Say «ذلك».", false], ["Use «لكي» for purpose.", true]]);
  assert.match(f.calls.at(-1).user, /^L3\. Use «لكي» for purpose\./m, "the pinned lesson is still in the prompt as a current lesson");

  // Over the cap, new lessons go and the pinned one stays.
  const current = Array.from({ length: MAX_LESSONS }, (_, i) => ({ ...L(`old ${i}`), pinned: i === MAX_LESSONS - 1 }));
  const merged = mergeLessons(current, { lessons: [{ id: null, lesson: "new", before: "", after: "", evidence: 1 }], reversed: [`L${MAX_LESSONS}`] }, ctx, 3);
  assert.equal(merged.length, MAX_LESSONS);
  assert.equal(merged.filter((l) => l.pinned).length, 1, "a pinned lesson named as reversed stays");
});

test("a deleted lesson does not come back from the notes it was learned from, only from newer approvals (#908)", async () => {
  const f = await fresh();
  assert.equal((await f.run()).status, "ok");
  const first = await loadCurrentLessons(f.env.DB);
  assert.match(first.lessons[0].lesson, /فيمكنك/);
  assert.equal((await editLesson(f.env, { setId: first.runId, position: 1, action: "delete", userId: 9, now: NIGHT1 + 60 })).ok, true);

  // A new approval with an unrelated change: the window still shows يمكنك → فيمكنك
  // (older notes) and the fake model proposes it again. Dropped.
  approveOther(f, "a");
  assert.equal((await f.run(NIGHT2)).status, "ok");
  assert.equal(f.calls.length, 2);
  assert.deepEqual((await loadCurrentLessons(f.env.DB)).lessons, [], "not brought back from the same old notes");

  // An editor makes the same correction in a note approved after the delete: it may return.
  f.approveMore();
  assert.equal((await f.run(NIGHT3)).status, "ok");
  const back = (await loadCurrentLessons(f.env.DB)).lessons;
  assert.equal(back.length, 1);
  assert.equal(back[0].after, "فيمكنك");

  // deletedStill, directly: wording alone matches too, and an example-less deletion never lifts.
  const d = [{ lesson: "Do X.", before: "", after: "", approvalsThrough: 5 }];
  assert.equal(deletedStill({ lesson: "do x.", before: "a", after: "b" }, d, [{ before: "a", after: "b", lastApproval: 99 }]), true);
  assert.equal(deletedStill({ lesson: "Other.", before: "a", after: "b" }, d, []), false);
});

test("promote: the line is added once, and a full Common issues refuses with 413 (#908)", async () => {
  assert.equal(appendCommonIssue(null, "- a"), "- a");
  assert.equal(appendCommonIssue("x\n\n", "- a"), "x\n- a");
  assert.equal(appendCommonIssue("x\n- a\n", "- a"), "x\n- a\n", "an existing identical line is not added again");
  assert.equal(promotedLine({ lesson: "L.", before: "b", after: "", evidence: 7, firstSeenAt: 1, pinned: false }), "- L. Example: «b» → «∅»");

  const f = await withThree();
  f.sqlite.prepare(`UPDATE translation_prefs SET common_issues_md = ? WHERE id = 1`).run("x".repeat(49990));
  const { runId } = await loadCurrentLessons(f.env.DB);
  const out = await editLesson(f.env, { setId: runId, position: 1, action: "promote", userId: 9 });
  assert.deepEqual(out, { ok: false, status: 413, error: "common_issues_full" });
  assert.equal((await loadCurrentLessons(f.env.DB)).lessons.length, 3, "the lesson stays when promote is refused");

  // No prefs row yet: promote creates it (version 1) with a 'create' history entry.
  f.sqlite.prepare(`DELETE FROM translation_prefs`).run();
  const ok = await editLesson(f.env, { setId: runId, position: 1, action: "promote", userId: 9 });
  assert.equal(ok.ok, true);
  assert.equal(ok.prefs.version, 1);
  assert.equal(ok.prefs.common_issues_md, "- Start with «فيمكنك». Example: «يمكنك» → «فيمكنك»");
  assert.equal(f.sqlite.prepare(`SELECT action FROM edit_log WHERE kind = 'prefs' ORDER BY id DESC LIMIT 1`).get().action, "create");
});

test("suggestion inbox: a card whose change is a current lesson's example is covered, only while lessons are on (#908)", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, chapter: 1 + (i % 3), draftNote: `مهم جدا ${i}`, finalNote: `مهم ${i}` }));
  const base = { rules: [], terms: [], templates: [], commonIssues: "", rejected: new Set() };
  assert.equal(buildInbox(rows, base).suggestions.length, 1);
  const covered = buildInbox(rows, { ...base, lessons: [{ before: "جدا", after: "" }] });
  assert.equal(covered.suggestions.length, 0);
  assert.equal(covered.excluded.lesson, 1);
  assert.equal(buildInbox(rows, { ...base, lessons: [{ before: "جدا", after: "كثيرا" }] }).suggestions.length, 1);
  assert.equal(coveredByLesson({ before: "", after: "" }, [{ before: "", after: "" }]), false);

  // The loader reads the current set only while the switch is on.
  const f = await fresh();
  await f.run();
  const on = await computeInbox(f.env.DB, "MRK");
  assert.ok(on.excluded.lesson >= 1);
  await setLessonsEnabled(f.env.DB, false, 9);
  const off = await computeInbox(f.env.DB, "MRK");
  assert.equal(off.excluded.lesson, 0);
  assert.equal(off.suggestions.length, on.suggestions.length + on.excluded.lesson);
});

test("leftover 6: a database with 0085 but not 0086 reads as not_migrated, not a failure (#908)", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const file of readdirSync(dir).filter((x) => x.endsWith(".sql") && x < "0086").sort()) {
    sqlite.exec(readFileSync(join(dir, file), "utf8"));
  }
  const db = makeDb(sqlite);
  await setLessonsEnabled(db, true, null);
  assert.deepEqual(await runNightlyLessons({ DB: db, WORKSPACE_SLUG: "x" }, { now: NIGHT1 }), { ran: false, reason: "not_migrated" });
});

test("leftover 4: a stored resume whose approvals were un-approved since is stale; the newest chapters are mined (#908)", async () => {
  const f = await fresh();
  await f.runWith(NIGHT1, { cells: 1 });
  assert.equal(f.runs().at(-1).truncated, 1, "night 1 stopped among new approvals in MRK 3 + MRK 2");
  // Every note of MRK 2 and MRK 3 is sent back to draft, then editors approve in MRK 4.
  f.sqlite.prepare(`UPDATE tn_rows SET translation_state = 'draft' WHERE chapter IN (2, 3)`).run();
  approveIn(f, 4, "c401");
  const out = await f.run(NIGHT2);
  assert.equal(out.status, "ok");
  assert.match(f.calls[1].user, /Chapters: MRK 4, MRK 1\./, "not the stale MRK 3, MRK 2");
});

test("a lesson moved to Common issues does not come back from the same notes, even with no word on one side (#908)", async () => {
  const f = await fresh();
  // A deletion-shaped lesson: Common issues' own cover needs a word on both sides, so it cannot stop it.
  const del = [{ id: null, lesson: "Drop «جدا» here.", before: "جدا", after: "", evidence: 3 }];
  f.setReply(replyWith(del));
  assert.equal((await f.run()).status, "ok");
  const { runId } = await loadCurrentLessons(f.env.DB);
  assert.equal((await editLesson(f.env, { setId: runId, position: 1, action: "promote", userId: 9, now: NIGHT1 + 60 })).ok, true);
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM lesson_deletions`).get().n, 1);
  approveOther(f, "p");
  assert.equal((await f.run(NIGHT2)).status, "ok");
  assert.deepEqual((await loadCurrentLessons(f.env.DB)).lessons, [], "not written back the next night");
});

// ── gate review (#908): G2 kept lessons and tombstones, G3 no-op pin, G4 restore clears tombstones ──

test("G2: a night cannot rewrite a kept lesson into a deleted one from the old notes (#908)", () => {
  const current = [L("Keep A.", "أ", "ب"), L("Keep B.", "ج", "د")];
  const deleted = [{ lesson: "Gone.", before: "x", after: "y", approvalsThrough: 100 }];
  const parsed = {
    lessons: [
      { id: "L1", lesson: "Gone.", before: "أ", after: "ب", evidence: 4 },
      { id: "L2", lesson: "Keep B, reworded.", before: "x", after: "y", evidence: 6 },
    ],
    reversed: [],
  };
  const out = mergeLessons(current, parsed, { ...ctx, deleted, changes: [{ before: "x", after: "y", lastApproval: 90 }] }, 5);
  assert.deepEqual(
    out.map((l) => [l.lesson, l.before, l.after]),
    [["Keep A.", "أ", "ب"], ["Keep B.", "ج", "د"]],
    "both kept lessons keep their own wording and example",
  );
  assert.equal(out[1].evidence, 6, "the new evidence count is still taken");
  // Supported anew (a note approved after the delete): the rewrite is allowed.
  const anew = mergeLessons(current, parsed, { ...ctx, deleted, changes: [{ before: "x", after: "y", lastApproval: 101 }] }, 5);
  assert.deepEqual(anew[1].lesson, "Keep B, reworded.");
});

function countingExportEnv(f) {
  const seen = { lock: 0 };
  const db = f.env.DB;
  return {
    seen,
    env: {
      ...f.env,
      DB: { ...db, prepare: (sql) => (/context_export_lock/.test(sql) && seen.lock++, db.prepare(sql)) },
      DCS_SERVICE_TOKEN: "service-token",
      EXPORT_WORKFLOW: { create: async (o) => ({ id: o.id }) },
    },
  };
}

test("G3: pinning a lesson that is already pinned changes nothing and queues no export (#908)", async () => {
  const f = await withThree();
  const { seen, env } = countingExportEnv(f);
  const admin = appFor(env, "admin");
  const post = (body) =>
    admin("/api/translation-memory/lessons/edit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const { runId } = await loadCurrentLessons(f.env.DB);
  let res = await post({ setId: runId, position: 1, action: "unpin" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).setId, runId, "no new set");
  assert.equal(seen.lock, 0, "no context export queued");
  res = await post({ setId: runId, position: 1, action: "pin" });
  const pinned = await res.json();
  assert.notEqual(pinned.setId, runId);
  assert.ok(seen.lock > 0, "a real change queues the export");
  const before = seen.lock;
  res = await post({ setId: pinned.setId, position: 1, action: "pin" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).setId, pinned.setId);
  assert.equal(seen.lock, before, "pinning again queues nothing");
  assert.equal((await post({ setId: runId, position: 1, action: "pin" })).status, 409, "a stale set is still refused");
});

test("G4: restoring a set clears the tombstones of the lessons it brings back; Common issues is left alone (#908)", async () => {
  const f = await withThree();
  const s1 = (await loadCurrentLessons(f.env.DB)).runId;
  let out = await editLesson(f.env, { setId: s1, position: 1, action: "delete", userId: 9, now: NIGHT1 + 60 });
  assert.equal(out.ok, true);
  let cur = (await loadCurrentLessons(f.env.DB)).runId;
  out = await editLesson(f.env, { setId: cur, position: 2, action: "promote", userId: 9, now: NIGHT1 + 61 });
  assert.equal(out.ok, true);
  const ci = out.prefs.common_issues_md;
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM lesson_deletions`).get().n, 2);
  cur = (await loadCurrentLessons(f.env.DB)).runId;
  assert.equal((await restoreLessonSet(f.env, { setId: s1, currentSetId: cur, userId: 9, now: NIGHT1 + 62 })).ok, true);
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM lesson_deletions`).get().n, 0, "both restored lessons are live again");
  assert.equal(f.sqlite.prepare(`SELECT common_issues_md FROM translation_prefs WHERE id = 1`).get().common_issues_md, ci);
  // The night that follows may keep, reword or re-add them like any other lesson.
  assert.deepEqual(deletedStill({ lesson: THREE[0].lesson, before: THREE[0].before, after: THREE[0].after }, [], []), false);
});

// ── review leftovers (#912) ─────────────────────────────────────────────────

const MRK = (chapter) => ({ book: "MRK", chapter });
const maxApproval = (f) => f.sqlite.prepare(`SELECT MAX(id) AS w FROM edit_log WHERE action = 'validate'`).get().w;

test("#912 item 1: a finished resume moves the watermark up to the newest chapters' first unmined approval", async () => {
  const f = await fresh();
  await f.runWith(NIGHT1, { cells: 1 }); // stops among MRK 3 + MRK 2
  const c4 = approveIn(f, 4, "c401", "قال الكاتب", "كتب الكاتب");
  assert.equal((await f.run(NIGHT2)).status, "ok");
  assert.match(f.calls[1].user, /Chapters: MRK 3, MRK 2\./, "night 2 finishes the stopped run's chapters");
  assert.equal(f.runs().at(-1).approvals_through, c4 - 1, "everything below MRK 4's approval was mined");
  // Night 3, one-note budget: the note diffed first is MRK 4's new one, not a MRK 3 note night 2 already compared.
  const out3 = await f.runWith(NIGHT3, { cells: 1 });
  assert.equal(out3.status, "ok");
  assert.match(f.calls[2].user, /Chapters: MRK 4, MRK 3\./);
  assert.match(f.calls[2].user, /^- 1× «قال» → «كتب»/m);
  assert.match(f.calls[2].user, /compared with their AI draft: 1;/);
  assert.equal(f.runs().at(-1).truncated, 0, "only already-mined notes were left: not a stop");
  assert.equal(f.runs().at(-1).approvals_through, c4);
});

test("#912 item 1: no paid call the night after a resume when nothing it left is still unmined", async () => {
  const f = await fresh();
  await f.runWith(NIGHT1, { cells: 1 });
  approveIn(f, 4, "c401", "قال الكاتب", "كتب الكاتب");
  assert.equal((await f.run(NIGHT2)).status, "ok");
  // MRK 4's note goes back to draft: every approval left was mined by night 2.
  f.sqlite.prepare(`UPDATE tn_rows SET translation_state = 'draft' WHERE id = 'c401'`).run();
  assert.equal((await f.run(NIGHT3)).reason, "no_new_approvals");
  assert.equal(f.calls.length, 2, "no call spent on notes night 2 already compared");
});

// Item 2 itself (a resume that stops again can pass an approval in the newest
// chapters) was left open here and fixed by #915 with per-chapter marks (see
// the #915 cases below): one watermark cannot hold "the resumed chapters are
// done through S" and "the newest chapters are unmined from F" at once.
// Holding a stopped resume below F made it resume from the same note every
// night; this case keeps that from coming back.
test("#912 item 2 (left open): a resume that stops again still moves the watermark forward every night", async () => {
  const f = await fresh();
  // A finished run that stopped among MRK 3 + MRK 2, every approval up to now mined.
  const w1 = maxApproval(f);
  f.sqlite
    .prepare(
      `INSERT INTO lesson_runs (night, started_at, finished_at, status, approvals_through, chapters_json, truncated)
       VALUES ('2026-11-11', 1, 1, 'no_changes', ?, ?, 1)`,
    )
    .run(w1, JSON.stringify([MRK(3), MRK(2)]));
  // Between nights: one approval in MRK 4, then three more back in MRK 3.
  approveIn(f, 4, "c401", "قال الكاتب", "كتب الكاتب");
  approveIn(f, 3, "m301");
  approveIn(f, 3, "m302");
  const m3c = approveIn(f, 3, "m303");
  let prev = w1;
  for (const night of [NIGHT1, NIGHT2, NIGHT3]) {
    assert.equal((await f.runWith(night, { cells: 1 })).status, "ok");
    const through = f.runs().at(-1).approvals_through;
    assert.ok(through > prev, `night ${night}: the watermark moved from ${prev} to ${through}`);
    prev = through;
  }
  assert.equal(prev, m3c);
  assert.match(f.calls[0].user, /Chapters: MRK 3, MRK 2\./, "the resume");
});

// ── a resume's per-chapter progress (#915) ──────────────────────────────────

// A finished night run that stopped among MRK 3 + MRK 2, every approval up to now mined.
function stoppedRun(f) {
  const w1 = maxApproval(f);
  f.sqlite
    .prepare(
      `INSERT INTO lesson_runs (night, started_at, finished_at, status, approvals_through, chapters_json, truncated)
       VALUES ('2026-11-11', 1, 1, 'no_changes', ?, ?, 1)`,
    )
    .run(w1, JSON.stringify([MRK(3), MRK(2)]));
  return w1;
}
const SAID = /«قال» → «كتب»/;
const WENT = /«ذهب» → «مضى»/;

test("#915: a resume that stops again leaves no approval in the newest chapters unmined", async () => {
  const f = await fresh();
  stoppedRun(f);
  // Between nights: one approval in MRK 4, then two more back in MRK 3.
  approveIn(f, 4, "c401", "قال الكاتب", "كتب الكاتب");
  approveIn(f, 3, "m301");
  approveIn(f, 3, "m302");
  assert.equal((await f.runWith(NIGHT1, { cells: 1 })).status, "ok");
  assert.equal(f.runs().at(-1).truncated, 1, "night 1: the resume stops again");
  // Between nights 1 and 2: one more in MRK 4.
  approveIn(f, 4, "c402", "ذهب الرجل", "مضى الرجل");
  const nights = [NIGHT2, NIGHT3, NIGHT3 + 86400, NIGHT3 + 2 * 86400];
  for (const night of nights.slice(0, 3)) assert.equal((await f.runWith(night, { cells: 1 })).status, "ok");
  assert.match(f.calls[1].user, /Chapters: MRK 3, MRK 2\./, "night 2 finishes the resume");
  assert.match(f.calls[2].user, /Chapters: MRK 4, MRK 3\./, "night 3 mines the newest chapters");
  assert.match(f.calls[2].user, SAID, "MRK 4's first approval (made before night 1) reaches the model");
  assert.match(f.calls[3].user, WENT, "night 4 finishes MRK 4: its second approval reaches the model");
  assert.equal((await f.runWith(nights[3], { cells: 1 })).reason, "no_new_approvals", "then nothing is left");
  assert.equal(f.calls.length, 4);
});

test("#915: an approval a resume left owed is mined even after editors moved on to other chapters", async () => {
  const f = await fresh();
  stoppedRun(f);
  approveIn(f, 4, "c401", "قال الكاتب", "كتب الكاتب");
  approveIn(f, 3, "m301");
  approveIn(f, 3, "m302");
  assert.equal((await f.runWith(NIGHT1, { cells: 1 })).status, "ok");
  assert.equal(f.runs().at(-1).truncated, 1, "night 1: the resume stops again; MRK 4 waits");
  // Editors move on: MRK 5 and MRK 6 are now the newest chapters, MRK 4 is not.
  approveIn(f, 5, "c501");
  approveIn(f, 6, "c601");
  assert.equal((await f.runWith(NIGHT2, { cells: 1 })).status, "ok");
  assert.match(f.calls[1].user, /Chapters: MRK 3, MRK 2\./, "night 2 finishes the resume");
  assert.equal(f.runs().at(-1).truncated, 0);
  assert.equal((await f.run(NIGHT3)).status, "ok");
  assert.match(f.calls[2].user, /Chapters: MRK 6, MRK 5, MRK 4\./, "the newest chapters, plus the one the resume left owed");
  assert.match(f.calls[2].user, SAID);
  assert.equal((await f.run(NIGHT3 + 86400)).reason, "no_new_approvals");
});

// Interleaved approvals: newest chapter MRK 4 gets c1, then resumed MRK 3 gets a2 > c1.
async function interleaved() {
  const f = await fresh();
  await f.runWith(NIGHT1, { cells: 1 }); // stops among MRK 3 + MRK 2
  const c1 = approveIn(f, 4, "c401", "قال الكاتب", "كتب الكاتب");
  const a2 = approveIn(f, 3, "m301", "ذهب الرجل", "مضى الرجل");
  assert.equal((await f.run(NIGHT2)).status, "ok");
  assert.match(f.calls[1].user, /Chapters: MRK 3, MRK 2\./, "night 2 finishes the resume, a2 included");
  assert.match(f.calls[1].user, WENT);
  return { f, c1, a2 };
}

test("#915: a finished resume's own later approval is not new again: a one-note night diffs c1 and is done", async () => {
  const { f, a2 } = await interleaved();
  const out3 = await f.runWith(NIGHT3, { cells: 1 });
  assert.equal(out3.status, "ok");
  assert.match(f.calls[2].user, /Chapters: MRK 3, MRK 4\./);
  assert.match(f.calls[2].user, SAID, "night 3 diffs MRK 4's c1");
  assert.equal(f.runs().at(-1).truncated, 0, "a2 is not left over as a new approval");
  assert.equal(f.runs().at(-1).approvals_through, a2);
  assert.equal((await f.runWith(NIGHT3 + 86400, { cells: 1 })).reason, "no_new_approvals");
  assert.equal(f.calls.length, 3, "a2 is never sent to the model a second time");
});

test("#915: a database with 0087 but not 0088 reads as not_migrated, on the night and on the page", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const file of readdirSync(dir).filter((x) => x.endsWith(".sql") && x < "0088").sort()) {
    sqlite.exec(readFileSync(join(dir, file), "utf8"));
  }
  const env = { DB: makeDb(sqlite), WORKSPACE_SLUG: "x" };
  await setLessonsEnabled(env.DB, true, null);
  assert.deepEqual(await runNightlyLessons(env, { now: NIGHT1 }), { ran: false, reason: "not_migrated" });
  assert.equal((await readLessonsState(env)).notMigrated, true);
});

test("#915: no paid call when the only approval above the watermark is one the resume already mined", async () => {
  const { f } = await interleaved();
  // c1 goes back to draft: what is left above the watermark is a2, mined on night 2.
  f.sqlite.prepare(`UPDATE tn_rows SET translation_state = 'draft' WHERE id = 'c401'`).run();
  assert.equal((await f.run(NIGHT3)).reason, "no_new_approvals");
  assert.equal(f.calls.length, 2);
});

test("#912 item 3: a deleted lesson's example, shared by a kept lesson, does not stop that lesson's rewording", () => {
  const current = [L("Keep B.", "x", "y")];
  const deleted = [{ lesson: "Gone A.", before: "x", after: "y", approvalsThrough: 100 }];
  const reword = (lesson) => ({ lessons: [{ id: "L1", lesson, before: "x", after: "y", evidence: 6 }], reversed: [] });
  const out = mergeLessons(current, reword("Keep B, reworded."), { ...ctx, deleted, changes: [] }, 5);
  assert.deepEqual(out.map((l) => l.lesson), ["Keep B, reworded."]);
  // G2 still holds: the kept lesson cannot take the deleted lesson's wording.
  assert.deepEqual(mergeLessons(current, reword("Gone A."), { ...ctx, deleted, changes: [] }, 5).map((l) => l.lesson), ["Keep B."]);
  // A new lesson with the deleted example is still dropped.
  const fresh1 = { lessons: [{ id: null, lesson: "Other.", before: "x", after: "y", evidence: 2 }], reversed: [] };
  assert.deepEqual(mergeLessons([], fresh1, { ...ctx, deleted, changes: [] }, 5), []);
});

test("#912 item 3: restoring a set keeps the tombstone of a deleted lesson it does not hold, even on a shared example", async () => {
  const f = await fresh();
  const A = { id: null, lesson: "Start with «فيمكنك».", before: "يمكنك", after: "فيمكنك", evidence: 5 };
  const B = { id: null, lesson: "Prefer «فيمكنك» at the start.", before: "يمكنك", after: "فيمكنك", evidence: 4 };
  f.setReply(replyWith([A, B]));
  assert.equal((await f.run()).status, "ok");
  const s1 = (await loadCurrentLessons(f.env.DB)).runId;
  assert.equal((await editLesson(f.env, { setId: s1, position: 1, action: "delete", userId: 9, now: NIGHT1 + 60 })).ok, true);
  const s2 = (await loadCurrentLessons(f.env.DB)).runId; // [B]
  assert.equal((await editLesson(f.env, { setId: s2, position: 1, action: "pin", userId: 9, now: NIGHT1 + 61 })).ok, true);
  const s3 = (await loadCurrentLessons(f.env.DB)).runId;
  assert.equal((await restoreLessonSet(f.env, { setId: s2, currentSetId: s3, userId: 9, now: NIGHT1 + 62 })).ok, true);
  const tomb = f.sqlite.prepare(`SELECT lesson FROM lesson_deletions`).all();
  assert.deepEqual(tomb.map((t) => t.lesson), [A.lesson], "A was not restored: its deletion stands");
});

function loadTombs(f) {
  return f.sqlite
    .prepare(`SELECT lesson, example_before AS before, example_after AS after, approvals_through AS approvalsThrough FROM lesson_deletions`)
    .all();
}

test("#912 item 4: restore clears a tombstone that differs from the restored lesson only in case or spacing", async () => {
  const f = await withThree();
  const s1 = (await loadCurrentLessons(f.env.DB)).runId;
  assert.equal((await editLesson(f.env, { setId: s1, position: 1, action: "pin", userId: 9, now: NIGHT1 + 60 })).ok, true);
  const s2 = (await loadCurrentLessons(f.env.DB)).runId;
  // The night compares NFC, one line, lowercase: this is THREE[2]'s deletion record.
  f.sqlite
    .prepare(`INSERT INTO lesson_deletions (lesson, example_before, example_after, approvals_through) VALUES (?, ?, ?, 1)`)
    .run("use «لكي»   FOR purpose.", " أن", "لكي ");
  assert.equal(deletedStill(THREE[2], loadTombs(f), []), true, "the night reads it as the same lesson");
  assert.equal((await restoreLessonSet(f.env, { setId: s1, currentSetId: s2, userId: 9, now: NIGHT1 + 61 })).ok, true);
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM lesson_deletions`).get().n, 0);
});

// A DB whose guarded write meets a nightly run that has ended by the time the
// refusal is read (or, with `bumpPrefs`, a Common issues save made meanwhile).
function racingEnv(f, { bumpPrefs = false } = {}) {
  const db = f.env.DB;
  return {
    ...f.env,
    DB: {
      ...db,
      async batch(stmts) {
        if (bumpPrefs) f.sqlite.prepare(`UPDATE translation_prefs SET version = version + 1 WHERE id = 1`).run();
        else f.sqlite.prepare(`INSERT INTO lesson_runs (night, started_at, status, approvals_through) VALUES ('race', ?, 'running', 1)`).run(NIGHT2);
        try {
          return await db.batch(stmts);
        } finally {
          if (!bumpPrefs) f.sqlite.prepare(`UPDATE lesson_runs SET status = 'no_changes', finished_at = ? WHERE night = 'race'`).run(NIGHT2);
        }
      },
    },
  };
}

test("#912 item 5: a change refused by a nightly run that ended meanwhile is not reported as a Common issues change", async () => {
  const f = await withThree();
  const s1 = (await loadCurrentLessons(f.env.DB)).runId;
  const now = NIGHT2 + 10;
  for (const action of ["delete", "pin", "promote"]) {
    const out = await editLesson(racingEnv(f), { setId: s1, position: 1, action, userId: 9, now });
    assert.deepEqual(out, { ok: false, status: 409, error: "run_in_progress" }, action);
    f.sqlite.prepare(`DELETE FROM lesson_runs WHERE night = 'race'`).run();
  }
  const pinned = await editLesson(f.env, { setId: s1, position: 1, action: "pin", userId: 9, now });
  assert.equal(pinned.ok, true);
  const s2 = (await loadCurrentLessons(f.env.DB)).runId;
  assert.deepEqual(await restoreLessonSet(racingEnv(f), { setId: s1, currentSetId: s2, userId: 9, now }), {
    ok: false,
    status: 409,
    error: "run_in_progress",
  });
  // A promote whose Common issues moved meanwhile is prefs_changed.
  const out = await editLesson(racingEnv(f, { bumpPrefs: true }), { setId: s2, position: 2, action: "promote", userId: 9, now });
  assert.deepEqual(out, { ok: false, status: 409, error: "prefs_changed" });
  assert.equal((await loadCurrentLessons(f.env.DB)).runId, s2, "nothing landed");
});

test("#912 item 7 (closed by #911): Common issues text typed before a promote the page never heard of gets a 409, not an overwrite", async () => {
  const f = await withThree();
  const before = f.sqlite.prepare(`SELECT version, common_issues_md FROM translation_prefs WHERE id = 1`).get();
  const s1 = (await loadCurrentLessons(f.env.DB)).runId;
  const promoted = await editLesson(f.env, { setId: s1, position: 1, action: "promote", userId: 9, now: NIGHT1 + 60 });
  assert.equal(promoted.ok, true); // ...and the reply is lost on the way to the page.
  const after = promoted.prefs;
  const typed = { common_issues_md: `${before.common_issues_md}\n- typed meanwhile` };
  const base = { common_issues_md: before.common_issues_md };
  // The version the page sends (#911): the typed-against one, whether or not a
  // later reply brought the new prefs row in.
  const stale = prefsVersionToSend(base, before.version, typed, base, before.version);
  const refreshed = prefsVersionToSend({ common_issues_md: after.common_issues_md }, after.version, typed, base, before.version);
  assert.equal(stale, before.version);
  assert.equal(refreshed, before.version, "after a refresh, the changed box still sends the version it was typed against");
  const admin = appFor(f.env, "admin");
  for (const version of [stale, refreshed]) {
    const res = await admin("/api/translation-memory/prefs", {
      method: "PUT",
      headers: { "content-type": "application/json", "If-Match": String(version) },
      body: JSON.stringify(typed),
    });
    assert.equal(res.status, 409);
  }
  assert.equal(f.sqlite.prepare(`SELECT common_issues_md FROM translation_prefs WHERE id = 1`).get().common_issues_md, after.common_issues_md);
});

test("#912 item 8: a same-night retry after an admin change writes a set that becomes current", async () => {
  const f = await withThree();
  f.approveMore();
  // Tonight's run was killed long ago; while it sat stale, an admin pinned a lesson.
  f.sqlite
    .prepare(`INSERT INTO lesson_runs (night, started_at, status, approvals_through) VALUES ('2026-11-13', ?, 'running', 1)`)
    .run(NIGHT2 - RUN_STALE_SECONDS - 60);
  const s1 = (await loadCurrentLessons(f.env.DB)).runId;
  assert.equal((await editLesson(f.env, { setId: s1, position: 1, action: "pin", userId: 9, now: NIGHT2 })).ok, true);
  const edited = (await loadCurrentLessons(f.env.DB)).runId;
  f.setReply(replyWith([{ id: null, lesson: "A new one.", before: "ب", after: "ج", evidence: 1 }]));
  const out = await f.run(NIGHT2);
  assert.equal(out.status, "ok");
  assert.ok(out.runId > edited, "the retry is a newer set than the admin's change");
  const cur = await loadCurrentLessons(f.env.DB);
  assert.equal(cur.runId, out.runId);
  assert.ok(cur.lessons.some((l) => l.lesson === "A new one."));
  assert.equal(cur.lessons.find((l) => l.lesson === THREE[0].lesson).pinned, true, "built on the admin's change");
  assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM lesson_runs WHERE night = '2026-11-13'`).get().n, 1);
  f.approveMore();
  assert.equal((await f.run(NIGHT2 + 60)).reason, "already_ran", "still one run a night");
});
