// Unit tests for httpJson.ts — the boundary schema-validation helpers (#484).
//
// No network: parseJson is fed constructed Response objects, and fetchJson is
// exercised by stubbing globalThis.fetch. The load-bearing assertions are that
// a shape mismatch is REJECTED (not carried inward) and that the thrown error
// names the boundary and the offending field.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/httpJson.test.mjs

import assert from "node:assert/strict";
import { z } from "zod";
import { parseJson, fetchJson, ResponseSchemaError } from "./httpJson.ts";

let passed = 0;
async function t(name, fn) {
  await fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const User = z.object({
  id: z.number(),
  login: z.string(),
  full_name: z.string().optional(),
});

await t("parseJson returns typed data on a matching body (extra keys stripped)", async () => {
  const res = new Response(JSON.stringify({ id: 7, login: "ada", token_type: "bearer" }));
  const data = await parseJson(res, User, "DCS user profile");
  assert.equal(data.id, 7);
  assert.equal(data.login, "ada");
  assert.equal(data.full_name, undefined);
  // Unknown keys are dropped by a default zod object, not surfaced.
  assert.equal("token_type" in data, false);
});

await t("parseJson rejects a shape mismatch, naming endpoint + field", async () => {
  const res = new Response(JSON.stringify({ id: "not-a-number", login: "ada" }));
  await assert.rejects(
    () => parseJson(res, User, "DCS user profile"),
    (err) => {
      assert.ok(err instanceof ResponseSchemaError);
      assert.equal(err.endpoint, "DCS user profile");
      assert.match(err.detail, /id/); // the offending field is named
      return true;
    },
  );
});

await t("parseJson rejects a missing required field", async () => {
  const res = new Response(JSON.stringify({ login: "ada" })); // no id
  await assert.rejects(
    () => parseJson(res, User, "DCS user profile"),
    (err) => err instanceof ResponseSchemaError && /id/.test(err.detail),
  );
});

await t("parseJson rejects a non-JSON body (e.g. an HTML error page)", async () => {
  const res = new Response("<html>504 Gateway Timeout</html>", { status: 200 });
  await assert.rejects(
    () => parseJson(res, User, "DCS user profile"),
    (err) => err instanceof ResponseSchemaError && /valid JSON/.test(err.detail),
  );
});

await t("fetchJson rejects a non-ok status before parsing, carrying the status", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 502 });
  try {
    await assert.rejects(
      () => fetchJson("https://dcs.example/api/v1/user", User),
      (err) => {
        assert.ok(err instanceof ResponseSchemaError);
        assert.equal(err.status, 502);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

await t("fetchJson parses a matching body on 200", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 1, login: "z" }), { status: 200 });
  try {
    const data = await fetchJson("https://dcs.example/api/v1/user", User);
    assert.equal(data.login, "z");
  } finally {
    globalThis.fetch = original;
  }
});

console.log(`\n${passed} passed`);
