// House-style rule admin routes (issue #815): GET /api/translation-memory/
// house-style-rules lists the rules with their examples; PATCH .../:id switches
// one on or off. Both admin-only; the PATCH accepts `{enabled}` and nothing else.
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/houseStyleRoutes.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { translationMemory } from "./translationMemory.ts";

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
  return { prepare: (sql) => mk(sql, []), async batch(stmts) { return stmts.map((s) => s.run()); } };
}

function fresh(role) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (8, 808, 'boss')`).run();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", 8);
    c.set("role", role);
    await next();
  });
  app.route("/api/translation-memory", translationMemory);
  const env = { DB: makeDb(sqlite) };
  const call = async (method, path, body) => {
    const res = await app.request(
      `/api/translation-memory/house-style-rules${path}`,
      { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
      env,
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const enabled = (id) => sqlite.prepare(`SELECT enabled FROM house_style_rules WHERE id = ?`).get(id).enabled;
  return { call, enabled };
}

test("admin lists the seed rules with examples, all switched off", async () => {
  const h = fresh("admin");
  const r = await h.call("GET", "");
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.rules.map((x) => [x.id, x.kind, x.enabled, x.supported]),
    [
      ["ar-drop-mukayyaf-tag", "literal", false, true],
      ["ar-mufidan-tanween", "whole_word", false, true],
      ["ar-final-bracket-period", "final_bracket_period", false, true],
    ],
  );
  assert.ok(r.body.rules.every((x) => x.examples.length > 0 && x.counterExamples.length > 0));
});

test("admin switches a rule on and off; who changed it is reported", async () => {
  const h = fresh("admin");
  const on = await h.call("PATCH", "/ar-final-bracket-period", { enabled: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.rule.enabled, true);
  assert.equal(on.body.rule.updatedBy, "boss");
  assert.equal(h.enabled("ar-final-bracket-period"), 1);
  const off = await h.call("PATCH", "/ar-final-bracket-period", { enabled: false });
  assert.equal(off.body.rule.enabled, false);
  assert.equal(h.enabled("ar-final-bracket-period"), 0);
});

test("PATCH accepts only {enabled}; an unknown id is 404", async () => {
  const h = fresh("admin");
  assert.equal((await h.call("PATCH", "/ar-mufidan-tanween", { enabled: true, find: "x" })).status, 400);
  assert.equal((await h.call("PATCH", "/ar-mufidan-tanween", { enabled: "yes" })).status, 400);
  assert.equal(h.enabled("ar-mufidan-tanween"), 0);
  assert.equal((await h.call("PATCH", "/no-such-rule", { enabled: true })).status, 404);
});

test("editors can neither list nor switch rules", async () => {
  const h = fresh("editor");
  assert.equal((await h.call("GET", "")).status, 403);
  assert.equal((await h.call("PATCH", "/ar-mufidan-tanween", { enabled: true })).status, 403);
  assert.equal(h.enabled("ar-mufidan-tanween"), 0);
});
