// Undo for a deleted term (#801): each restore answer maps to the right
// message, refreshes only when something changed, and every key has copy in
// both catalogs (check-i18n only sees literal t("…") calls, not these).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { restoreFailure, restoreMessage } from "./termRestore.ts";

const lookup = (catalog, key) => key.split(".").reduce((o, k) => (o == null ? o : o[k]), catalog);
const en = JSON.parse(readFileSync(new URL("../i18n/locales/en.json", import.meta.url), "utf8"));
const ar = JSON.parse(readFileSync(new URL("../i18n/locales/ar.json", import.meta.url), "utf8"));

test("409 duplicate_term names the live term and changes nothing", () => {
  const o = restoreFailure(409, {
    error: "duplicate_term",
    current: { id: 9, source_term: "grace", target_term: "gracia", status: "preferred" },
  });
  assert.deepEqual(o, { kind: "duplicate", source: "grace", target: "gracia" });
  const m = restoreMessage(o);
  assert.equal(m.key, "preferences.termRestoreDuplicate");
  assert.deepEqual(m.values, { source: "grace", target: "gracia" });
  assert.equal(m.refresh, false);
});

test("409 duplicate_term without current still classifies", () => {
  assert.deepEqual(restoreFailure(409, { error: "duplicate_term", current: null }), {
    kind: "duplicate",
    source: "",
    target: "",
  });
});

test("409 not_deleted only refreshes", () => {
  const o = restoreFailure(409, { error: "not_deleted", current: {} });
  assert.equal(o.kind, "not_deleted");
  assert.equal(restoreMessage(o).refresh, true);
});

test("409 version_mismatch changes nothing", () => {
  const o = restoreFailure(409, { error: "version_mismatch", current: {} });
  assert.equal(o.kind, "version_mismatch");
  assert.equal(restoreMessage(o).refresh, false);
});

test("404 is not_found; other errors are generic", () => {
  assert.equal(restoreFailure(404, { error: "not_found" }).kind, "not_found");
  assert.equal(restoreFailure(500, null).kind, "failed");
  assert.equal(restoreFailure(409, null).kind, "failed");
  assert.equal(restoreMessage({ kind: "restored" }).refresh, true);
});

test("every outcome's message key has copy in en and ar", () => {
  const kinds = ["restored", "not_deleted", "duplicate", "version_mismatch", "not_found", "failed"];
  for (const kind of kinds) {
    const { key } = restoreMessage({ kind, source: "a", target: "b" });
    assert.equal(typeof lookup(en, key), "string", `en ${key}`);
    assert.equal(typeof lookup(ar, key), "string", `ar ${key}`);
  }
  for (const key of ["preferences.termDeleted"]) {
    assert.equal(typeof lookup(en, key), "string", `en ${key}`);
    assert.equal(typeof lookup(ar, key), "string", `ar ${key}`);
  }
});
