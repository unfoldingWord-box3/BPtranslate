// Issue #818: "Draft missing templates from approved notes".
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/templateDraftMissing.test.mjs
//
// The REAL routes against the REAL migration schema. The model call is a fake
// Transport (the seam llm.ts already uses for its own tests); nothing here
// touches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import {
  draftMissingRoutes,
  parseTemplateOutput,
  buildTemplatePrompt,
  MAX_EXAMPLES_PER_SLUG,
  MAX_SLUGS_PER_RUN,
} from "./templateDraftMissing.ts";
import { templates } from "./templates.ts";
import { loadContextPackInputs } from "./contextExport.ts";
import { encryptApiKey } from "./aiKeyCrypto.ts";
import { clearProjectConfigCache } from "./projectConfig.ts";
import { BEGIN_OUTPUT, END_OUTPUT } from "./translate/llm.ts";

const WRAPPING_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const PLAINTEXT_KEY = "sk-ant-api03-notarealkey-000000wxyz";
const ADMIN = 9;
const EDITOR = 7;

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
      const out = [];
      for (const s of stmts) out.push(s.run());
      return out;
    },
  };
}

// slug -> { approved, form, units: [[id, state, target_md, draft_meta_json, pre_draft_json]] }
const SLUGS = {
  // 35 approved, rc:// form: qualifies; the example cap (30) applies.
  "figs-metaphor": { approved: 35, form: "rc", units: [["figs-metaphor-01", null], ["figs-metaphor-02", null]] },
  // Exactly 20, bare form: qualifies (the threshold is inclusive).
  "translate-names": { approved: 20, form: "bare", units: [["translate-names-01", null]] },
  // 19 human-approved: below the bar. Bulk-approved and trashed notes added below do not count.
  "figs-idiom": { approved: 19, form: "rc", units: [["figs-idiom-01", null]] },
  // Already has an approved unit: never drafted.
  "figs-simile": { approved: 30, form: "rc", units: [["figs-simile-01", "validated", "تشبيه معتمد"], ["figs-simile-02", null]] },
  // One unit a person is editing: only the untouched one is drafted.
  "writing-newevent": { approved: 22, form: "rc", units: [["writing-newevent-01", "edited", "عمل بشري جار"], ["writing-newevent-02", null]] },
  // Only an older AI draft (the bot's "Draft all", before #551): redrafted from the notes.
  "grammar-connect-logic-result": {
    approved: 40,
    form: "rc",
    units: [["grammar-connect-logic-result-01", "ai_draft", "مسودة قديمة", null, JSON.stringify({ target_md: "منشور سابقًا" })]],
  },
  // A draft this feature already wrote: not redrafted, so not a candidate.
  "figs-hyperbole": {
    approved: 25,
    form: "rc",
    units: [["figs-hyperbole-01", "ai_draft", "مسودة من الملاحظات", JSON.stringify({ source: "approved_notes", approved_note_count: 25 }), null]],
  },
};

async function fresh({ provider = "claude", model = "claude-sonnet-5", withKey = true, extraSlugs = 0 } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (?, 909, 'admin')`).run(ADMIN);
  sqlite.prepare(`INSERT INTO project_config (id, preset, overrides_json, updated_at) VALUES (1, 'ar-bsoj', NULL, unixepoch())`).run();

  const unit = sqlite.prepare(
    `INSERT INTO template_units (template_id, support_ref, sheet_order, type, source_md, source_hash, origin, target_md, translation_state, draft_meta_json, pre_draft_json, version)
     VALUES (?, ?, ?, 'note', ?, 'h', 'sheet', ?, ?, ?, ?, 1)`,
  );
  const tn = sqlite.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, support_reference, quote, note, sort_order, version, translation_state, updated_at, admin_bulk_state, trashed_at)
     VALUES (?, ?, 1, ?, ?, ?, 'quote', ?, 10, 2, 'validated', ?, ?, ?)`,
  );
  const aiLog = sqlite.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, payload_json)
     VALUES ('tn', ?, ?, NULL, 1, 2, 'update', 'ai_pipeline', ?)`,
  );
  let order = 0;
  let idn = 0;
  const seedSlug = (slug, spec) => {
    for (const [id, state, target, meta, pre] of spec.units) {
      unit.run(id, slug, ++order, `English template for ${slug} [ALT]`, target ?? null, state, meta ?? null, pre ?? null);
    }
    const ref = spec.form === "rc" ? `rc://*/ta/man/translate/${slug}` : slug;
    for (let i = 0; i < spec.approved; i++) {
      const id = `n${(idn++).toString(36).padStart(3, "0")}`;
      tn.run(id, "TIT", i + 1, `1:${i + 1}`, ref, `فيمكنك ${slug} ${i}`, 1000 + i, null, null);
      // Every other note began as an AI draft the editor changed.
      if (i % 2 === 0) aiLog.run(id, "TIT", JSON.stringify({ id, note: `يمكنك ${slug} ${i}` }));
    }
  };
  for (const [slug, spec] of Object.entries(SLUGS)) seedSlug(slug, spec);
  for (let k = 0; k < extraSlugs; k++) seedSlug(`extra-${k}`, { approved: 21, form: "rc", units: [[`extra-${k}-01`, null]] });

  // figs-idiom: 5 bulk-approved and 3 trashed approved notes do not lift it to 20.
  for (let i = 0; i < 5; i++) tn.run(`b${i}`, "TIT", 50 + i, `1:${50 + i}`, "rc://*/ta/man/translate/figs-idiom", "bulk", 1, "approved", null);
  for (let i = 0; i < 3; i++) tn.run(`t${i}`, "TIT", 60 + i, `1:${60 + i}`, "rc://*/ta/man/translate/figs-idiom", "trashed", 1, null, 1);
  // Same id in another book with an AI draft: must not leak into TIT's pair.
  aiLog.run("n000", "JUD", JSON.stringify({ note: "WRONG BOOK" }));

  if (withKey) {
    const { ciphertextB64, ivB64 } = await encryptApiKey(WRAPPING_KEY, PLAINTEXT_KEY);
    sqlite
      .prepare(
        `INSERT INTO ai_provider_config (id, provider, model, key_ciphertext, key_iv, key_hint, version, updated_at)
         VALUES (1, ?, ?, ?, ?, 'wxyz', 1, unixepoch())`,
      )
      .run(provider, model, ciphertextB64, ivB64);
  }

  const calls = [];
  let behaviour = null;
  const transport = async (req) => {
    calls.push(req);
    if (behaviour) {
      const r = await behaviour(req, sqlite);
      if (r) return r;
    }
    const ids = [...req.user.matchAll(/^## Template (\S+)/gm)].map((m) => m[1]);
    const obj = Object.fromEntries(ids.map((id) => [id, `قالب ${id} فيمكنك [ALT]`]));
    return {
      text: `${BEGIN_OUTPUT}\n${JSON.stringify(obj)}\n${END_OUTPUT}`,
      usage: { inputTokens: 1000, outputTokens: 200 },
      stopReason: "end_turn",
    };
  };

  const slug = `t${Math.random().toString(36).slice(2)}`;
  clearProjectConfigCache(slug);
  const env = { DB: makeDb(sqlite), AI_KEY_WRAPPING_KEY: WRAPPING_KEY, WORKSPACE_SLUG: slug };
  const appFor = (role, userId) => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("userId", userId);
      c.set("role", role);
      await next();
    });
    app.route("/api/templates/draft-missing", draftMissingRoutes({ transport }));
    app.route("/api/templates", templates);
    return app;
  };
  const req = (path, init, role = "admin", userId = ADMIN) => appFor(role, userId).request(path, init, env);
  const post = (body, role) =>
    req("/api/templates/draft-missing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }, role);
  const unitRow = (id) => sqlite.prepare(`SELECT * FROM template_units WHERE template_id = ?`).get(id);
  const snapshot = () => sqlite.prepare(`SELECT template_id, target_md, translation_state, version, draft_meta_json FROM template_units ORDER BY template_id`).all();
  return { sqlite, env, req, post, unitRow, snapshot, calls, setBehaviour: (b) => (behaviour = b) };
}

const DRAFTED = ["figs-metaphor-01", "figs-metaphor-02", "grammar-connect-logic-result-01", "translate-names-01", "writing-newevent-02"];
const COUNTS = {
  "figs-metaphor-01": 35,
  "figs-metaphor-02": 35,
  "grammar-connect-logic-result-01": 40,
  "translate-names-01": 20,
  "writing-newevent-02": 22,
};

test("preview lists only qualifying slugs, busiest first, through the real templates router", async () => {
  const { req, calls } = await fresh();
  const res = await req("/api/templates/draft-missing", { method: "GET" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, true);
  assert.equal(body.provider, "claude");
  assert.deepEqual(
    body.qualifying,
    [
      { slug: "grammar-connect-logic-result", approvedNotes: 40, units: 1 },
      { slug: "figs-metaphor", approvedNotes: 35, units: 2 },
      { slug: "writing-newevent", approvedNotes: 22, units: 1 },
      { slug: "translate-names", approvedNotes: 20, units: 1 },
    ],
  );
  assert.equal(body.minApprovedNotes, 20);
  assert.equal(calls.length, 0, "the preview makes no model call");
});

test("a run drafts qualifying slugs' untouched and older-AI-draft units as ai_draft, with the note count", async () => {
  const { post, unitRow, sqlite, calls } = await fresh();
  const res = await post();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(
    body.drafted.map((d) => [d.slug, d.approvedNotes, d.units]).sort(),
    [["figs-metaphor", 35, 2], ["grammar-connect-logic-result", 40, 1], ["translate-names", 20, 1], ["writing-newevent", 22, 1]],
  );
  assert.deepEqual(body.failed, []);
  assert.equal(body.remaining, 0);
  assert.equal(typeof body.estimatedCostUsd, "number");

  assert.equal(calls.length, 4, "one call per slug");
  for (const c of calls) {
    assert.equal(c.apiKey, PLAINTEXT_KEY, "the org's own decrypted key");
    assert.equal(c.provider, "claude");
    assert.equal(c.model, "claude-sonnet-5");
    assert.equal(c.thinking, "low");
    assert.ok(c.timeoutMs <= 120_000);
  }

  for (const id of DRAFTED) {
    const u = unitRow(id);
    assert.equal(u.translation_state, "ai_draft", `${id} is an AI draft`);
    assert.equal(u.target_md, `قالب ${id} فيمكنك [ALT]`);
    assert.equal(u.version, 2);
    assert.equal(u.updated_by, ADMIN);
    const meta = JSON.parse(u.draft_meta_json);
    assert.equal(meta.source, "approved_notes");
    assert.equal(meta.approved_note_count, COUNTS[id]);
    assert.equal(meta.example_count, Math.min(COUNTS[id], 30));
    const published = id === "grammar-connect-logic-result-01" ? "منشور سابقًا" : null;
    assert.equal(JSON.parse(u.pre_draft_json).target_md, published, "the last-published snapshot is kept (draft over draft) or taken fresh");
  }

  // Left alone: an approved unit, its untouched sibling, a person's edit, a
  // draft this feature already wrote, and a slug below the bar.
  assert.equal(unitRow("figs-simile-01").translation_state, "validated");
  assert.equal(unitRow("figs-simile-02").translation_state, null);
  assert.equal(unitRow("writing-newevent-01").translation_state, "edited");
  assert.equal(unitRow("writing-newevent-01").target_md, "عمل بشري جار");
  assert.equal(unitRow("writing-newevent-01").version, 1);
  assert.equal(unitRow("figs-hyperbole-01").target_md, "مسودة من الملاحظات");
  assert.equal(unitRow("figs-hyperbole-01").version, 1);
  assert.equal(unitRow("figs-idiom-01").translation_state, null);

  const log = sqlite
    .prepare(`SELECT row_key, source, action, prev_version, new_version, user_id, payload_json FROM edit_log WHERE kind = 'template' ORDER BY row_key`)
    .all();
  assert.deepEqual(log.map((l) => l.row_key), [...DRAFTED].sort());
  for (const l of log) {
    assert.equal(l.source, "ai_pipeline");
    assert.equal(l.action, "update");
    assert.equal(l.prev_version, 1);
    assert.equal(l.new_version, 2);
    assert.equal(l.user_id, ADMIN);
    const p = JSON.parse(l.payload_json);
    assert.equal(p.target_md, `قالب ${l.row_key} فيمكنك [ALT]`);
    assert.ok(p.approved_note_count >= 20);
  }
});

test("the prompt carries the English templates, at most 30 recent approved notes, and draft→final pairs from the same book", async () => {
  const { post, calls } = await fresh();
  await post();
  const metaphor = calls.find((c) => c.user.includes("# SupportReference: figs-metaphor"));
  assert.ok(metaphor);
  assert.match(metaphor.system, /Arabic \(ar, written rtl\)/);
  assert.match(metaphor.user, /## Template figs-metaphor-01/);
  assert.match(metaphor.user, /## Template figs-metaphor-02/);
  assert.match(metaphor.user, /English template for figs-metaphor \[ALT\]/);
  assert.match(metaphor.user, /Approved notes for this slug: 35 \(the 30 most recent are shown\)/);
  assert.equal(MAX_EXAMPLES_PER_SLUG, 30);
  assert.ok(metaphor.user.includes(`### Note 30 `));
  assert.ok(!metaphor.user.includes(`### Note 31 `));
  // Most recent first: note 34 (updated_at 1034) leads, note 0..4 are cut.
  assert.ok(metaphor.user.includes("Approved: فيمكنك figs-metaphor 34"));
  assert.ok(!metaphor.user.includes("Approved: فيمكنك figs-metaphor 4\n"));
  assert.ok(metaphor.user.includes("AI draft: يمكنك figs-metaphor 34"), "draft→final pair shown");
  assert.ok(!metaphor.user.includes("WRONG BOOK"), "edit_log is matched on book as well as id");
  assert.ok(!calls.some((c) => c.user.includes("SupportReference: figs-idiom")));
  assert.ok(!calls.some((c) => c.user.includes("SupportReference: figs-simile")));
  assert.ok(!calls.some((c) => c.user.includes("SupportReference: figs-hyperbole")), "a draft this feature wrote is not redrafted");
});

test("a second press makes no calls once every qualifying slug has a draft", async () => {
  const { post, calls } = await fresh();
  await post();
  const before = calls.length;
  const res = await post();
  const body = await res.json();
  assert.equal(calls.length, before);
  assert.deepEqual(body.drafted, []);
  assert.equal(body.remaining, 0);
});

test("drafts are not exported until an editor approves them", async () => {
  const { post, env, sqlite } = await fresh();
  await post();
  const inputs = await loadContextPackInputs(env.DB);
  assert.deepEqual(inputs.templates.map((t) => t.template_id), ["figs-simile-01"], "only the human-approved template reaches the pack");
  sqlite.prepare(`UPDATE template_units SET translation_state = 'validated' WHERE template_id = 'translate-names-01'`).run();
  const after = await loadContextPackInputs(env.DB);
  assert.deepEqual(after.templates.map((t) => t.template_id).sort(), ["figs-simile-01", "translate-names-01"]);
});

test("no key configured: a clear refusal and no call", async () => {
  const { post, req, snapshot, calls } = await fresh({ withKey: false });
  const before = snapshot();
  const res = await post();
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "ai_provider_not_configured");
  const preview = await (await req("/api/templates/draft-missing", { method: "GET" })).json();
  assert.equal(preview.available, false);
  assert.equal(preview.reason, "ai_provider_not_configured");
  assert.equal(preview.qualifying.length, 4, "the preview still counts what would be drafted");
  assert.equal(calls.length, 0);
  assert.deepEqual(snapshot(), before);
});

test("a provider the Worker has no adapter for is refused before any call", async () => {
  const { post, snapshot, calls } = await fresh({ provider: "openai", model: "gpt-5.5" });
  const before = snapshot();
  const res = await post();
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "provider_not_supported");
  assert.equal(body.provider, "openai");
  assert.equal(calls.length, 0);
  assert.deepEqual(snapshot(), before);
});

test("a key that no longer decrypts is refused before any call", async () => {
  const { post, env, calls } = await fresh();
  env.AI_KEY_WRAPPING_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const res = await post();
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "ai_provider_key_decrypt_failed");
  assert.equal(calls.length, 0);
});

test("editors cannot run it or see the preview", async () => {
  const { req, calls } = await fresh();
  assert.equal((await req("/api/templates/draft-missing", { method: "POST" }, "editor", EDITOR)).status, 403);
  assert.equal((await req("/api/templates/draft-missing", { method: "GET" }, "editor", EDITOR)).status, 403);
  assert.equal(calls.length, 0);
});

test("a person who starts a unit while the model is writing keeps their text", async () => {
  const { post, unitRow, setBehaviour } = await fresh();
  setBehaviour(async (r, sqlite) => {
    if (r.user.includes("SupportReference: translate-names")) {
      sqlite
        .prepare(`UPDATE template_units SET target_md = 'كتبه شخص', translation_state = 'edited', version = version + 1 WHERE template_id = 'translate-names-01'`)
        .run();
    }
    return null;
  });
  const body = await (await post()).json();
  assert.equal(unitRow("translate-names-01").target_md, "كتبه شخص");
  assert.equal(unitRow("translate-names-01").translation_state, "edited");
  assert.deepEqual(body.failed, [{ slug: "translate-names", code: "not_written" }]);
});

test("a template approved while the model is writing is not overwritten", async () => {
  const { post, unitRow, setBehaviour } = await fresh();
  // Approve flips the state without a version bump (POST /unit/validate).
  setBehaviour(async (r, sqlite) => {
    if (r.user.includes("SupportReference: grammar-connect-logic-result")) {
      sqlite
        .prepare(`UPDATE template_units SET translation_state = 'validated' WHERE template_id = 'grammar-connect-logic-result-01'`)
        .run();
    }
    return null;
  });
  const body = await (await post()).json();
  const u = unitRow("grammar-connect-logic-result-01");
  assert.equal(u.translation_state, "validated");
  assert.equal(u.target_md, "مسودة قديمة");
  assert.deepEqual(body.failed, [{ slug: "grammar-connect-logic-result", code: "not_written" }]);
});

test("an invalid key stops the run without writing anything", async () => {
  const { post, snapshot, setBehaviour, calls } = await fresh();
  const before = snapshot();
  setBehaviour(async () => {
    throw Object.assign(new Error("authentication_error: invalid x-api-key"), { status: 401 });
  });
  const body = await (await post()).json();
  assert.ok(body.failed.some((f) => f.code === "invalid_key"));
  assert.deepEqual(body.drafted, []);
  assert.equal(body.remaining, 4);
  assert.ok(calls.length <= 3, "at most the calls already in flight");
  assert.deepEqual(snapshot(), before);
});

test("unreadable model output writes nothing for that slug", async () => {
  const { post, unitRow, setBehaviour } = await fresh();
  setBehaviour(async (r) =>
    r.user.includes("SupportReference: writing-newevent")
      ? { text: "I cannot help with that.", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" }
      : null,
  );
  const body = await (await post()).json();
  assert.deepEqual(body.failed, [{ slug: "writing-newevent", code: "unreadable_output" }]);
  assert.equal(unitRow("writing-newevent-02").translation_state, null);
  assert.equal(body.remaining, 1);
});

test("a press handles a bounded batch and reports how many remain; skipSlugs moves past a failing slug", async () => {
  const { post, calls } = await fresh({ extraSlugs: 6 });
  const first = await (await post()).json();
  assert.equal(calls.length, MAX_SLUGS_PER_RUN);
  assert.equal(first.drafted.length, MAX_SLUGS_PER_RUN);
  assert.equal(first.remaining, 10 - MAX_SLUGS_PER_RUN);

  const second = await (await post({ skipSlugs: ["extra-5"] })).json();
  assert.ok(!second.drafted.some((d) => d.slug === "extra-5"));
  assert.equal(second.remaining, 1, "the skipped slug still counts as remaining");
});

test("parseTemplateOutput reads JSON between the markers or in a fence, and drops missing or empty ids", () => {
  const ids = ["a-01", "a-02", "a-03"];
  const m = parseTemplateOutput(`${BEGIN_OUTPUT}\n{"a-01":" one ","a-02":"","x":"y"}\n${END_OUTPUT}`, ids);
  assert.deepEqual([...m.entries()], [["a-01", "one"]]);
  const f = parseTemplateOutput('```json\n{"a-03":"three"}\n```', ids);
  assert.deepEqual([...f.entries()], [["a-03", "three"]]);
  assert.equal(parseTemplateOutput("not json", ids).size, 0);
  assert.equal(parseTemplateOutput(`${BEGIN_OUTPUT}\n["a-01"]\n${END_OUTPUT}`, ids).size, 0);
});

test("buildTemplatePrompt asks for every template id", () => {
  const { user } = buildTemplatePrompt({
    languageName: "Arabic",
    languageCode: "ar",
    direction: "rtl",
    slug: "figs-x",
    approvedNotes: 21,
    units: [{ template_id: "figs-x-01", type: null, source_md: "src" }, { template_id: "figs-x-02", type: "note", source_md: "src2" }],
    examples: [{ ref: "TIT 1:1", quote: null, note: "ok", aiNote: null }],
  });
  assert.ok(user.includes('{"figs-x-01":"…","figs-x-02":"…"}'));
  assert.ok(!user.includes("AI draft:"));
});
