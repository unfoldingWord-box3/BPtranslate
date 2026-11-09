import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { fetchChapter, newUserContext, type TnRow } from "./helpers";

// Rapid check bulk actions (#829): checkboxes with Shift+click ranges,
// select-all, Space / X / Shift+J to check from the keyboard, and the bulk
// Approve and Not needed verbs with Undo for Not needed.
//
// It WRITES (approves, sets notes aside, restores them), so it works on
// ZEC 4, a chapter no other spec in this suite opens. global-setup seeds
// ZEC 4's notes as AI drafts so they can be approved.

const BOOK = "ZEC";
const CHAPTER = 4;

test.describe.configure({ timeout: 120_000 });

const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of openContexts.splice(0)) await c.close().catch(() => {});
});

type Row = TnRow & { translation_state?: string | null; trashed_at?: number | null };

async function serverRows(context: BrowserContext, token: string): Promise<Map<string, Row>> {
  const c = await fetchChapter(context.request, token, BOOK, CHAPTER);
  return new Map((c.tn as Row[]).map((r) => [r.id, r]));
}

async function openRapid(page: Page, verse: number, rowId: string) {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route("https://git.door43.org/**", (route) => route.fulfill({ status: 404, body: "not mocked" }));
  await page.goto(`/#/notes/${BOOK}/${CHAPTER}/${verse}?row=${rowId}`);
  const list = page.locator("[data-rapid-check]");
  await expect(list).toBeVisible({ timeout: 20_000 });
  return list;
}

test("rapid check bulk: Shift+click approve skips a stored draft; Not needed then Undo", async ({ browser }) => {
  const { context, auth } = await newUserContext(browser, "rapid-bulk");
  openContexts.push(context);
  await context.addInitScript(() => {
    try {
      localStorage.setItem("be:notesRapidCheck", "true");
    } catch {
      /* private mode */
    }
  });

  const chap = await fetchChapter(context.request, auth.token, BOOK, CHAPTER);
  const live = (chap.tn as Row[]).filter((r) => r.trashed_at == null && r.verse > 0);
  const byVerse = new Map<number, Row[]>();
  for (const r of live) byVerse.set(r.verse, [...(byVerse.get(r.verse) ?? []), r]);
  const verse = [...byVerse.keys()].sort((a, b) => a - b).find((v) => byVerse.get(v)!.length >= 4);
  expect(verse, `ZEC ${CHAPTER} needs a verse with 4+ notes`).toBeDefined();
  const verseRows = byVerse.get(verse!)!;
  for (const r of verseRows) expect(r.translation_state, `seeded ai_draft for ${r.id}`).toBe("ai_draft");

  const page = await context.newPage();
  const list = await openRapid(page, verse!, verseRows[0].id);
  const listRows = list.locator("[data-rapid-row]");
  await expect(listRows).toHaveCount(verseRows.length);
  const ids = (await listRows.evaluateAll((els) => els.map((el) => el.getAttribute("data-rapid-row")))) as string[];
  const box = (id: string) => list.locator(`[data-rapid-checkbox="${id}"]`);
  const current = list.locator('[data-rapid-row][aria-current="true"]');

  // A stored draft on the fourth note: open it, type, close the editor, and
  // move the cursor away. The typing waits in the drafts store.
  await list.locator(`[data-rapid-row="${ids[3]}"] button:not([data-rapid-approve]):not([data-rapid-select]):not([data-rapid-checkbox])`).click();
  const editor = list.locator('textarea:not([aria-hidden="true"])');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" unsaved bulk typing");
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await list.locator(`[data-rapid-select="${ids[0]}"]`).click();
  await expect(current).toHaveAttribute("data-rapid-row", ids[0]);
  await expect(list.locator(`[data-rapid-approve="${ids[3]}"]`)).toHaveAttribute(
    "aria-label",
    "This note has unsaved typing. Open it and use Save & Approve.",
  );
  // The app's "Unsaved: ..." reminder (#372) sits over the bottom bar; close it.
  const reminder = page.getByRole("status").filter({ hasText: "Unsaved:" });
  await reminder.getByRole("button", { name: "dismiss" }).click();
  await expect(reminder).toHaveCount(0);

  // No bulk bar until something is checked.
  const bar = page.locator("[data-rapid-bulk-bar]");
  await expect(bar).toHaveCount(0);

  // Select-all checks every note shown, and unchecks them again.
  const all = list.getByRole("checkbox", { name: "Check all notes shown" });
  await all.click();
  await expect(bar).toContainText(`Checked: ${ids.length}`);
  await all.click();
  await expect(bar).toHaveCount(0);

  // Click the first note's box, Shift+click the fourth: four checked.
  await box(ids[0]).click();
  await expect(all).toHaveAttribute("aria-checked", "mixed");
  await box(ids[3]).click({ modifiers: ["Shift"] });
  await expect(bar).toContainText("Checked: 4");
  for (const id of ids.slice(0, 4)) await expect(box(id)).toHaveAttribute("aria-checked", "true");

  // Approve: the three clean notes are approved, the drafted one is skipped
  // and reported, and stays checked.
  await page.screenshot({ path: test.info().outputPath("rapid-bulk-selected-1366x768.png") });
  await bar.getByRole("button", { name: "Approve", exact: true }).click();
  const result = page.locator("[data-rapid-bulk-result]");
  await expect(result).toContainText("Approved: 3. Skipped: 1 (unsaved typing: 1).", { timeout: 20_000 });
  let server = await serverRows(context, auth.token);
  for (const id of ids.slice(0, 3)) expect(server.get(id)?.translation_state, id).toBe("validated");
  expect(server.get(ids[3])?.translation_state).toBe("ai_draft");
  await expect(box(ids[3])).toHaveAttribute("aria-checked", "true");
  await expect(bar).toContainText("Checked: 1");
  // Approve offers no Undo: un-approving would not restore the AI-draft state.
  await expect(result.getByRole("button", { name: "Undo" })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("rapid-bulk-approved-1366x768.png") });

  // This is not a translation workspace, so bulk Redo is off, with the reason.
  const redoBtn = bar.getByRole("button", { name: "Redo with AI" });
  await expect(redoBtn).toBeDisabled();
  await expect(redoBtn).toHaveAttribute("title", /only in a translation workspace/);

  // Keyboard: Clear, then Space checks the current note and Shift+J extends.
  await bar.getByRole("button", { name: "Clear" }).click();
  await expect(bar).toHaveCount(0);
  // Space on a focused checkbox toggles it exactly once (click, then Space).
  await box(ids[1]).click();
  await expect(box(ids[1])).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Space");
  await expect(box(ids[1])).toHaveAttribute("aria-checked", "false");
  await expect(bar).toHaveCount(0);
  await list.focus();
  await page.keyboard.press("Space");
  await expect(box(ids[0])).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Shift+KeyJ");
  await expect(current).toHaveAttribute("data-rapid-row", ids[1]);
  await expect(box(ids[1])).toHaveAttribute("aria-checked", "true");
  // X toggles the current note: off, then on again.
  await page.keyboard.press("x");
  await expect(box(ids[1])).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("x");
  await expect(bar).toContainText("Checked: 2");

  // Not needed sets both aside; Undo (Ctrl+Z) brings them back, approved.
  await bar.getByRole("button", { name: "Not needed", exact: true }).click();
  await expect(result).toContainText("Marked not needed: 2.", { timeout: 20_000 });
  server = await serverRows(context, auth.token);
  for (const id of ids.slice(0, 2)) expect(server.get(id)?.trashed_at, id).not.toBeNull();
  await expect(result.getByRole("button", { name: "Undo" })).toBeVisible();
  await list.focus();
  await page.keyboard.press("Control+z");
  await expect(result).toContainText("Restored: 2.", { timeout: 20_000 });
  server = await serverRows(context, auth.token);
  for (const id of ids.slice(0, 2)) {
    expect(server.get(id)?.trashed_at, id).toBeNull();
    expect(server.get(id)?.translation_state, id).toBe("validated");
    await expect(list.locator(`[data-rapid-approve="${id}"]`)).toHaveAttribute("aria-label", "Approved. Click to remove the approval");
  }
  await expect(result.getByRole("button", { name: "Undo" })).toHaveCount(0);
});

test("rapid check bulk: Arabic UI draws the checkboxes and bar right to left", async ({ browser }) => {
  const { context, auth } = await newUserContext(browser, "rapid-bulk-ar");
  openContexts.push(context);
  await context.addInitScript(() => {
    try {
      localStorage.setItem("be:notesRapidCheck", "true");
      localStorage.setItem("be:uiLang", "ar");
    } catch {
      /* private mode */
    }
  });
  const chap = await fetchChapter(context.request, auth.token, BOOK, CHAPTER);
  const first = (chap.tn as Row[]).find((r) => r.trashed_at == null && r.verse > 0)!;
  const page = await context.newPage();
  const list = await openRapid(page, first.verse, first.id);
  const ids = (await list.locator("[data-rapid-row]").evaluateAll((els) => els.map((el) => el.getAttribute("data-rapid-row")))) as string[];
  await list.locator(`[data-rapid-checkbox="${ids[0]}"]`).click();
  await list.locator(`[data-rapid-checkbox="${ids[ids.length - 1]}"]`).click({ modifiers: ["Shift"] });
  const bar = page.locator("[data-rapid-bulk-bar]");
  await expect(bar).toContainText(`المحدد: ${ids.length}`);
  // Right to left: the checkbox column is the row's rightmost cell, right of
  // the approve circle.
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const boxX = (await list.locator(`[data-rapid-checkbox="${ids[0]}"]`).boundingBox())!.x;
  const circleX = (await list.locator(`[data-rapid-approve="${ids[0]}"]`).boundingBox())!.x;
  expect(boxX).toBeGreaterThan(circleX);
  // Read-only test: nothing is approved here.
  await page.screenshot({ path: test.info().outputPath("rapid-bulk-ar-1366x768.png") });
});
