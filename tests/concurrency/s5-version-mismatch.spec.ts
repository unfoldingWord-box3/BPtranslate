import { expect, test, request as apiRequest } from "@playwright/test";
import { authedRequest, csrfToken, fetchChapter, mintToken } from "./helpers";
import { ZEC_CHAPTERS } from "./chapters";

const CHAPTER = ZEC_CHAPTERS.shared.chapter;

// Honor BE_BASE_URL so the suite runs on a relocated port (mirrors s8).
const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";


// S5 — Pure-API version_mismatch contract.
// The cheapest way to prove optimistic concurrency is wired correctly: two
// PATCHes with the same If-Match header against the same row. First wins,
// second 409s with body shape { error: "version_mismatch", current: {...} }.
//
// If this test fails, every UI concurrency test downstream is also broken.
test("two PATCHes with the same If-Match: one wins, the other 409s", async () => {
  const ctx = await apiRequest.newContext({ baseURL: BASE });

  const alice = await mintToken(ctx, "alice");
  const bob = await mintToken(ctx, "bob");

  // Pick the first TN row on ZEC 6. The exact row doesn't matter — the test
  // only cares about the version contract — but reading once gives us a real
  // id + version pair.
  const chapter = await fetchChapter(ctx, alice.token, "ZEC", CHAPTER);
  expect(chapter.tn.length).toBeGreaterThan(0);
  const target = chapter.tn[0];
  const startingVersion = target.version;

  // Both users share `ctx`, so its be_csrf cookie holds the last mint's value;
  // send that on both (it matches the cookie). The version contract under test
  // doesn't depend on which user wins.
  const csrf = await csrfToken(ctx);
  const aliceApi = authedRequest(ctx, alice.token, csrf);
  const bobApi = authedRequest(ctx, bob.token, csrf);

  // Two concurrent PATCHes, both claiming the same expected version.
  const [aRes, bRes] = await Promise.all([
    aliceApi.patch(`/api/rows/tn/${target.id}?book=ZEC`, { note: "alice wrote this" }, startingVersion),
    bobApi.patch(`/api/rows/tn/${target.id}?book=ZEC`, { note: "bob wrote this" }, startingVersion),
  ]);

  const statuses = [aRes.status(), bRes.status()].sort();
  expect(statuses).toEqual([200, 409]);

  // The 409 body must carry the version_mismatch shape the client uses to
  // distinguish "stale" from "gone" (api/src/rows.ts:434).
  const losing = aRes.status() === 409 ? aRes : bRes;
  const winning = aRes.status() === 200 ? aRes : bRes;
  const loserBody = await losing.json();
  expect(loserBody.error).toBe("version_mismatch");
  expect(loserBody.current).toBeDefined();
  expect(loserBody.current.version).toBe(startingVersion + 1);

  // Winner's response should carry the post-update row at version+1.
  const winnerBody = await winning.json();
  expect(winnerBody.version).toBe(startingVersion + 1);

  // Loser sees the winner's text reported back in `current` — that's the
  // recovery hook the outbox uses to render the conflict ("your edit X was
  // rejected; current is Y"). The mere shape is enough; we already know
  // which text won via winnerBody above.
  expect(typeof loserBody.current.note).toBe("string");

  // Server state matches the winner. The loser's text is NOT present.
  const after = await fetchChapter(ctx, alice.token, "ZEC", CHAPTER);
  const finalRow = after.tn.find((r) => r.id === target.id)!;
  expect(finalRow.note).toBe(winnerBody.note);
  const loserAttemptedText =
    aRes.status() === 409 ? "alice wrote this" : "bob wrote this";
  expect(finalRow.note).not.toBe(loserAttemptedText);

  await ctx.dispose();
});

// S5b — A retry with the *current* version succeeds. Proves the loser has a
// safe recovery path (this is the contract the outbox relies on after 409).
test("loser can retry with fresh If-Match and succeed", async () => {
  const ctx = await apiRequest.newContext({ baseURL: BASE });

  const alice = await mintToken(ctx, "alice");
  const chapter = await fetchChapter(ctx, alice.token, "ZEC", CHAPTER);
  // Use a different row so this test is order-independent vs the one above.
  const target = chapter.tn[1] ?? chapter.tn[0];
  const startingVersion = target.version;

  const api = authedRequest(ctx, alice.token, alice.csrf);

  // First PATCH wins.
  const first = await api.patch(
    `/api/rows/tn/${target.id}?book=ZEC`,
    { note: "first edit" },
    startingVersion,
  );
  expect(first.status()).toBe(200);

  // Second PATCH with the stale version fails.
  const stale = await api.patch(
    `/api/rows/tn/${target.id}?book=ZEC`,
    { note: "stale edit" },
    startingVersion,
  );
  expect(stale.status()).toBe(409);
  const staleBody = await stale.json();
  const currentVersion = staleBody.current.version;

  // Third PATCH with the fresh version succeeds.
  const retry = await api.patch(
    `/api/rows/tn/${target.id}?book=ZEC`,
    { note: "retried edit" },
    currentVersion,
  );
  expect(retry.status()).toBe(200);
  const retryBody = await retry.json();
  expect(retryBody.note).toBe("retried edit");
  expect(retryBody.version).toBe(currentVersion + 1);

  await ctx.dispose();
});
