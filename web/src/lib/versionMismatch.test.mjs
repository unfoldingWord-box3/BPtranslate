import test from "node:test";
import assert from "node:assert/strict";
import { versionMismatchRow } from "./versionMismatch.ts";

// Shape of web/src/sync/api.ts ApiError: { status, message, body }.
const apiError = (status, body) => Object.assign(new Error("x"), { status, body });

test("versionMismatchRow: the current row of a 409 version_mismatch, else null (#837)", () => {
  const row = { id: "abc", version: 4 };
  assert.deepEqual(versionMismatchRow(apiError(409, { error: "version_mismatch", current: row })), row);
  // Other 409s are not "changed elsewhere".
  assert.equal(versionMismatchRow(apiError(409, { error: "workspace_mismatch", expected: "bsoj" })), null);
  assert.equal(versionMismatchRow(apiError(409, { error: "chapter_locked", jobId: "j" })), null);
  assert.equal(versionMismatchRow(apiError(409, null)), null);
  // No usable row.
  assert.equal(versionMismatchRow(apiError(409, { error: "version_mismatch" })), null);
  assert.equal(versionMismatchRow(apiError(409, { error: "version_mismatch", current: { version: 4 } })), null);
  // Not a 409, or not an API error.
  assert.equal(versionMismatchRow(apiError(404, { error: "version_mismatch", current: row })), null);
  assert.equal(versionMismatchRow(new Error("version_mismatch")), null);
  assert.equal(versionMismatchRow(null), null);
  assert.equal(versionMismatchRow(undefined), null);
});
