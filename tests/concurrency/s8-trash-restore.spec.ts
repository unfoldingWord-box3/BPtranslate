import { expect, test, request as apiRequest } from "@playwright/test";
import { mintToken, newUserContext, gotoVerse } from "./helpers";
import { ZEC_CHAPTERS } from "./chapters";

const CHAPTER = ZEC_CHAPTERS.shared.chapter;

// S8 — Trash & restore for translation notes. The note delete button no longer
// hard-deletes: it moves the note to a visible, restorable "trash" state
// (trashed_at set) that stays in the chapter read, grayed and sorted last,
// until the nightly job finalizes it to a deleted_at tombstone. This contrasts
// with the DELETE primitive exercised in s6 (which removes the row outright).
//
// What we assert:
//   1. POST /trash keeps the row VISIBLE in another user's open view (not
//      hidden like a delete) and flips it to the grayed/restorable card.
//   2. The chapter read still returns the row, now carrying trashed_at.
//   3. POST /restore clears trashed_at and returns the card to normal.
// The WS path is the same row.upserted fanout that preserve/hint ride.
//
// Base URL is env-overridable so this can run against an isolated worktree
// stack (BE_BASE_URL=http://localhost:5174) without disturbing a peer on :5173.

const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";

test("alice's TRASH keeps the row visible+restorable in bob's view, then RESTORE returns it", async ({
  browser,
}) => {
  // Seed a throwaway row so we don't mutate the shared fixture.
  const setupCtx = await apiRequest.newContext({ baseURL: BASE });
  const setupAuth = await mintToken(setupCtx, "alice");
  const createRes = await setupCtx.post(`/api/rows/tn`, {
    headers: {
      Authorization: `Bearer ${setupAuth.token}`,
      "x-csrf-token": setupAuth.csrf,
      "Content-Type": "application/json",
    },
    data: { book: "ZEC", chapter: CHAPTER, verse: 1, ref_raw: `${CHAPTER}:1`, note: `to-be-trashed ${Date.now()}` },
  });
  expect(createRes.status()).toBe(201);
  const created = await createRes.json();
  await setupCtx.dispose();

  const { context: bobCtx } = await newUserContext(browser, "bob");
  const bob = await bobCtx.newPage();
  await gotoVerse(bob, "ZEC", CHAPTER, 1);
  const bobCard = bob.locator(`[data-note-id="${created.id}"]`);
  await bobCard.waitFor({ timeout: 10_000 });
  await bob.waitForTimeout(500); // let the WS subscription open

  // ── Alice trashes it ──
  const aliceCtx = await apiRequest.newContext({ baseURL: BASE });
  const aliceAuth = await mintToken(aliceCtx, "alice");
  const trashRes = await aliceCtx.post(`/api/rows/tn/${created.id}/trash?book=ZEC`, {
    headers: { Authorization: `Bearer ${aliceAuth.token}`, "x-csrf-token": aliceAuth.csrf },
  });
  expect(trashRes.status(), `trash failed: ${await trashRes.text()}`).toBe(200);
  expect((await trashRes.json()).trashed_at, "trash response carries trashed_at").toBeTruthy();

  // Bob still SEES the card (unlike a delete) and it gains the Restore button.
  await expect(bobCard).toBeVisible();
  await expect(
    bobCard.locator('[data-testid="RestoreFromTrashIcon"]'),
    "restore button appears on the trashed card in bob's view",
  ).toBeVisible({ timeout: 5_000 });

  // The chapter read still returns the row, now trashed.
  const readRes = await aliceCtx.get(`/api/chapters/ZEC/${CHAPTER}`, {
    headers: { Authorization: `Bearer ${aliceAuth.token}` },
  });
  const afterTrash = (await readRes.json()).tn.find((r: { id: string }) => r.id === created.id);
  expect(afterTrash, "trashed row still present in chapter read").toBeTruthy();
  expect(afterTrash.trashed_at, "chapter read exposes trashed_at").toBeTruthy();

  // ── Alice restores it ──
  const restoreRes = await aliceCtx.post(`/api/rows/tn/${created.id}/restore?book=ZEC`, {
    headers: { Authorization: `Bearer ${aliceAuth.token}`, "x-csrf-token": aliceAuth.csrf },
  });
  expect(restoreRes.status(), `restore failed: ${await restoreRes.text()}`).toBe(200);
  expect((await restoreRes.json()).trashed_at, "restore clears trashed_at").toBeNull();

  // Bob's card sheds the Restore button (back to a normal editable note).
  await expect(bobCard.locator('[data-testid="RestoreFromTrashIcon"]')).toBeHidden({ timeout: 5_000 });

  // Cleanup: trash again so the throwaway row doesn't linger as a live note in
  // the shared fixture; the nightly finalize would tombstone it anyway.
  await aliceCtx.post(`/api/rows/tn/${created.id}/trash?book=ZEC`, {
    headers: { Authorization: `Bearer ${aliceAuth.token}`, "x-csrf-token": aliceAuth.csrf },
  });

  await aliceCtx.dispose();
  await bobCtx.close();
});
