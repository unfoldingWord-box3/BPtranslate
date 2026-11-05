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
  assert.equal(restoreFailure(409, null).kind, "failed");
  assert.equal(restoreMessage({ kind: "restored" }).refresh, true);
});

// #809: after a 5xx the term is still deleted and the same id and version can
// be sent again, so the Undo offer comes back to retry. A 4xx other than
// 404/409 would fail the same way on a resend, so it ends with the generic
// message.
test("5xx is retryable with the retry message; other 4xx are final", () => {
  for (const status of [500, 502, 503, 504]) {
    const o = restoreFailure(status, { error: "unavailable" });
    assert.equal(o.kind, "retryable", `status ${status}`);
    const m = restoreMessage(o);
    assert.equal(m.key, "preferences.termRestoreRetry");
    assert.equal(m.refresh, false);
  }
  for (const status of [400, 401, 403, 422]) {
    assert.equal(restoreFailure(status, null).kind, "failed", `status ${status}`);
  }
});

test("every outcome's message key has copy in en and ar", () => {
  const kinds = ["restored", "not_deleted", "duplicate", "version_mismatch", "not_found", "failed", "retryable"];
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
