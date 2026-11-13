import { expect, test, request as apiRequest } from "@playwright/test";
import { fetchChapter, saveNote, gotoVerse, mintToken, newUserContext, noteTextarea, waitForServerNote } from "./helpers";
import { ZEC_CHAPTERS } from "./chapters";

const CHAPTER = ZEC_CHAPTERS.shared.chapter;

// Honor BE_BASE_URL so the suite runs on a relocated port (mirrors s8).
const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";


// S1 — Two users edit notes on adjacent verses of the same chapter at the
// same time. No clobbering: both edits land on the server intact.
//
// This is the headline win the project was built to enable. If this test
// passes, the row-level concurrency model works end-to-end through the UI,
// outbox, REST API, and D1.
test("two users editing adjacent verses both land — no clobber", async ({ browser }) => {
  // Pick targets BEFORE opening browsers so we have stable row ids to assert on.
  // The seed (globalSetup) gives us a fresh ZEC; we read its current shape.
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const probeAuth = await mintToken(probe, "probe");
  const chapter = await fetchChapter(probe, probeAuth.token, "ZEC", CHAPTER);

  // Find one TN row on verse 1 and one on verse 2. Both must exist in the
  // seed; if the sample data ever changes, fail loudly here instead of
  // halfway through a flaky UI test.
  const aliceTarget = chapter.tn.find((r) => r.verse === 1);
  const bobTarget = chapter.tn.find((r) => r.verse === 2);
  expect(aliceTarget, `expected at least one TN on ZEC ${CHAPTER}:1`).toBeDefined();
  expect(bobTarget, `expected at least one TN on ZEC ${CHAPTER}:2`).toBeDefined();
  await probe.dispose();

  const { context: aliceCtx } = await newUserContext(browser, "alice");
  const { context: bobCtx } = await newUserContext(browser, "bob");
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  // Each user navigates to the verse where their target row lives. The
  // resource column filters notes to the active verse, so a row on v2 isn't
  // mounted at the default v1.
  await Promise.all([
    gotoVerse(alice, "ZEC", CHAPTER, aliceTarget!.verse),
    gotoVerse(bob, "ZEC", CHAPTER, bobTarget!.verse),
  ]);

  const aliceNote = noteTextarea(alice, aliceTarget!.id);
  const bobNote = noteTextarea(bob, bobTarget!.id);

  const aliceText = `ALICE edit ${Date.now()}`;
  const bobText = `BOB edit ${Date.now()}`;
  await Promise.all([aliceNote.fill(aliceText), bobNote.fill(bobText)]);

  // Save: notes persist in the draft cache until the user clicks Save (no
  // autosave). Each user saves their own card; the two PATCHes hit the outbox
  // and drain in parallel so the network writes can race.
  await Promise.all([
    saveNote(alice, aliceTarget!.id),
    saveNote(bob, bobTarget!.id),
  ]);

  // Server is the source of truth. Read until both edits are visible there,
  // OR fail loudly with the last-seen state.
  const serverCtx = await apiRequest.newContext({ baseURL: BASE });
  const serverAuth = await mintToken(serverCtx, "verifier");
  const [aliceFinal, bobFinal] = await Promise.all([
    waitForServerNote(serverCtx, serverAuth.token, "ZEC", CHAPTER, aliceTarget!.id, (n) => n === aliceText),
    waitForServerNote(serverCtx, serverAuth.token, "ZEC", CHAPTER, bobTarget!.id, (n) => n === bobText),
  ]);

  expect(aliceFinal.note).toBe(aliceText);
  expect(bobFinal.note).toBe(bobText);
  // Neither row should have version > previous + a small bound. Catches any
  // pathological retry loop.
  expect(aliceFinal.version).toBeLessThanOrEqual(aliceTarget!.version + 3);
  expect(bobFinal.version).toBeLessThanOrEqual(bobTarget!.version + 3);

  await serverCtx.dispose();
  await aliceCtx.close();
  await bobCtx.close();
});
