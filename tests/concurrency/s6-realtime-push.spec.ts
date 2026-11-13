import { expect, test, request as apiRequest } from "@playwright/test";
import { authedRequest, fetchChapter, gotoVerse, mintToken, newUserContext, noteTextarea } from "./helpers";
import { ZEC_CHAPTERS } from "./chapters";

const CHAPTER = ZEC_CHAPTERS.shared.chapter;

// Honor BE_BASE_URL so the suite runs on a relocated port (mirrors s8).
const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";


// S6 — Live broadcast: when one user mutates a row, every other user with
// the same chapter open sees it within a couple of seconds without any
// navigation or refresh on their side. This is the WS-fanout path:
//   PATCH/POST/DELETE → DO POST /broadcast → all sockets → applyLocal*.
//
// Each sub-test picks a TN row that Bob does NOT have actively focused —
// NoteCard's session guard intentionally shields an in-progress edit from
// being clobbered by inbound prop changes (NoteCard.tsx:208-219), so the
// thing we want to observe is the no-active-session re-sync.

test("alice's PATCH appears in bob's open view", async ({ browser }) => {
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const probeAuth = await mintToken(probe, "probe");
  const chapter = await fetchChapter(probe, probeAuth.token, "ZEC", CHAPTER);
  // Pick a row on a verse with at least two notes so Bob's "active" card is
  // a different row from the one Alice will edit.
  const v1Notes = chapter.tn.filter((r) => r.verse === 1);
  expect(v1Notes.length, `expected ≥2 TN rows on ZEC ${CHAPTER}:1`).toBeGreaterThanOrEqual(2);
  const target = v1Notes[1];
  await probe.dispose();

  const { context: bobCtx } = await newUserContext(browser, "bob");
  const bob = await bobCtx.newPage();
  await gotoVerse(bob, "ZEC", CHAPTER, target.verse);

  const bobNote = noteTextarea(bob, target.id);
  await bobNote.waitFor({ timeout: 10_000 });
  // Give the WS subscription a beat to open before we mutate.
  await bob.waitForTimeout(500);

  const aliceCtx = await apiRequest.newContext({ baseURL: BASE });
  const aliceAuth = await mintToken(aliceCtx, "alice");
  const aliceApi = authedRequest(aliceCtx, aliceAuth.token, aliceAuth.csrf);
  const newText = `LIVE PUSH ${Date.now()}`;
  const res = await aliceApi.patch(
    `/api/rows/tn/${target.id}?book=ZEC`,
    { note: newText },
    target.version,
  );
  expect(res.status(), `PATCH failed: ${await res.text()}`).toBe(200);

  // Bob's textarea should re-sync via the WS push within a couple of seconds.
  await expect(bobNote).toHaveValue(newText, { timeout: 5_000 });

  await aliceCtx.dispose();
  await bobCtx.close();
});

test("alice's POST appears in bob's open view", async ({ browser }) => {
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const probeAuth = await mintToken(probe, "probe");
  const chapter = await fetchChapter(probe, probeAuth.token, "ZEC", CHAPTER);
  // Anchor: an existing row on v1 we can wait on for the page being ready.
  const anchor = chapter.tn.find((r) => r.verse === 1);
  expect(anchor, `expected at least one TN on ZEC ${CHAPTER}:1`).toBeDefined();
  await probe.dispose();

  const { context: bobCtx } = await newUserContext(browser, "bob");
  const bob = await bobCtx.newPage();
  await gotoVerse(bob, "ZEC", CHAPTER, anchor!.verse);
  await noteTextarea(bob, anchor!.id).waitFor({ timeout: 10_000 });
  await bob.waitForTimeout(500);

  const aliceCtx = await apiRequest.newContext({ baseURL: BASE });
  const aliceAuth = await mintToken(aliceCtx, "alice");
  const res = await aliceCtx.post(`/api/rows/tn`, {
    headers: {
      Authorization: `Bearer ${aliceAuth.token}`,
      "x-csrf-token": aliceAuth.csrf,
      "Content-Type": "application/json",
    },
    data: {
      book: "ZEC",
      chapter: CHAPTER,
      verse: anchor!.verse,
      ref_raw: `${CHAPTER}:${anchor!.verse}`,
      note: `LIVE CREATE ${Date.now()}`,
    },
  });
  expect(res.status(), `POST failed: ${await res.text()}`).toBe(201);
  const created = await res.json();

  // The freshly-created row should mount into Bob's resource column without
  // a refresh — its NoteCard wrapper carries data-note-id="<id>".
  await bob.locator(`[data-note-id="${created.id}"]`).waitFor({ timeout: 5_000 });

  await aliceCtx.dispose();
  await bobCtx.close();
});

test("alice's DELETE removes the row from bob's open view", async ({ browser }) => {
  // Seed a fresh row to delete so we don't damage the fixture for the
  // other specs. Alice creates → tests delete → Bob observes disappearance.
  const setupCtx = await apiRequest.newContext({ baseURL: BASE });
  const setupAuth = await mintToken(setupCtx, "alice");
  const createRes = await setupCtx.post(`/api/rows/tn`, {
    headers: {
      Authorization: `Bearer ${setupAuth.token}`,
      "x-csrf-token": setupAuth.csrf,
      "Content-Type": "application/json",
    },
    data: {
      book: "ZEC",
      chapter: CHAPTER,
      verse: 1,
      ref_raw: `${CHAPTER}:1`,
      note: `to-be-deleted ${Date.now()}`,
    },
  });
  expect(createRes.status()).toBe(201);
  const created = await createRes.json();
  await setupCtx.dispose();

  const { context: bobCtx } = await newUserContext(browser, "bob");
  const bob = await bobCtx.newPage();
  await gotoVerse(bob, "ZEC", CHAPTER, 1);
  await bob.locator(`[data-note-id="${created.id}"]`).waitFor({ timeout: 10_000 });
  await bob.waitForTimeout(500);

  const aliceCtx = await apiRequest.newContext({ baseURL: BASE });
  const aliceAuth = await mintToken(aliceCtx, "alice");
  const delRes = await aliceCtx.delete(`/api/rows/tn/${created.id}?book=ZEC`, {
    headers: {
      Authorization: `Bearer ${aliceAuth.token}`,
      "x-csrf-token": aliceAuth.csrf,
      "If-Match": String(created.version),
    },
  });
  expect(delRes.status(), `DELETE failed: ${await delRes.text()}`).toBe(200);

  // The row should disappear from Bob's view via the WS push.
  await expect(bob.locator(`[data-note-id="${created.id}"]`)).toBeHidden({ timeout: 5_000 });

  await aliceCtx.dispose();
  await bobCtx.close();
});
