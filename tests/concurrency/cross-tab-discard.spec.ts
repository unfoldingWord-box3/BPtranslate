import { expect, test, request as apiRequest, type BrowserContext, type Page } from "@playwright/test";
import { fetchChapter, gotoVerse, mintToken, newUserContext } from "./helpers";

// Honor BE_BASE_URL so the suite runs on a relocated port (mirrors s8).
const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";

// Issue #637 item 3. Any open tab can show the shared outbox's conflicts and
// discard one, but outbox.drop() used to tell only the tab it ran in. When the
// translator typed the save in tab B and threw it away from tab A, tab B kept
// the thrown-away text as its saved row until a reload. Now the discard
// reaches tab B (rowDropChannel.ts), which re-reads the row: a field still
// showing the thrown-away text goes back to the server's, and text typed in B
// since then stays as unsaved.
//
// Both pages live in ONE browser context: tabs share IndexedDB (the outbox)
// and BroadcastChannel only within a context. The 409 is answered by
// context.route and never reaches the server. ZEC 5 is used because no other
// spec writes to it; globalSetup re-imports ZEC each run.
const CHAPTER = 5;
const SHOTS = process.env.BE_SHOT_DIR;

interface TqRow {
  id: string;
  verse: number;
  question: string | null;
}

async function pickRow(skip: number): Promise<TqRow> {
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const auth = await mintToken(probe, "probe-637-tabs");
  const chapter = await fetchChapter(probe, auth.token, "ZEC", CHAPTER);
  await probe.dispose();
  const rows = (chapter.tq as TqRow[]).filter((r) => r.verse > 1);
  expect(rows.length, `expected tQ rows after verse 1 on ZEC ${CHAPTER}`).toBeGreaterThan(skip);
  return rows[skip];
}

async function openQuestions(page: Page, verse: number) {
  await gotoVerse(page, "ZEC", CHAPTER, verse);
  await page.getByRole("button", { name: /^Questions/ }).click();
}

function rowBox(page: Page, id: string) {
  return page.locator(`[data-question-id="${id}"]`);
}

function questionField(page: Page, id: string) {
  return rowBox(page, id).locator('textarea:not([aria-hidden="true"])').first();
}

function saveButton(page: Page, id: string) {
  return rowBox(page, id).locator('button:has([data-testid="SaveIcon"])');
}

// Every PATCH of the row is answered with a 409 that carries no current row:
// the outbox holds it as a conflict it cannot re-arm, and the status bar
// offers only to discard it.
async function conflictPatches(context: BrowserContext, id: string): Promise<() => number> {
  let n = 0;
  await context.route(`**/api/rows/tq/${id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    n++;
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "version_mismatch" }) });
  });
  return () => n;
}

// Save `typed` in tab B (a 409), then open tab A on the same chapter, where
// the status bar lists the conflict from the shared outbox.
async function conflictInB(context: BrowserContext, tq: TqRow, typed: string) {
  const b = await context.newPage();
  const seen = await conflictPatches(context, tq.id);
  await openQuestions(b, tq.verse);
  await questionField(b, tq.id).fill(typed);
  await saveButton(b, tq.id).click();
  await expect.poll(seen, { message: "the PATCH should reach the route" }).toBeGreaterThan(0);
  await expect(b.getByText(/^1 conflict$/).first()).toBeVisible();
  const a = await context.newPage();
  await openQuestions(a, tq.verse);
  return { a, b };
}

async function discardConflict(page: Page) {
  await page.bringToFront();
  await page.getByText(/^1 conflict$/).first().click();
  await page.getByText(/^resolve 1 conflict$/).click();
  await page.getByRole("dialog").getByRole("button", { name: /^discard$/i }).click();
}

test("a conflicted save typed in tab B and discarded in tab A: tab B shows the server text without a reload", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const tq = await pickRow(0);
  const server = tq.question ?? "";
  const { context } = await newUserContext(browser, "cross-tab-discard");
  const typed = `CROSS TAB ${Date.now()}`;
  const { a, b } = await conflictInB(context, tq, typed);
  // Before the discard, tab B shows its own (unsent) text as the row's.
  await expect(questionField(b, tq.id)).toHaveValue(typed);
  await expect(saveButton(b, tq.id)).toHaveCount(0);

  await discardConflict(a);

  // Tab B, never reloaded, goes back to the server's text with nothing unsaved.
  await expect(questionField(b, tq.id)).toHaveValue(server);
  await expect(saveButton(b, tq.id)).toHaveCount(0);
  // Its status bar no longer lists the conflict either.
  await expect(b.getByText(/^1 conflict$/)).toHaveCount(0);
  if (SHOTS) await b.screenshot({ path: `${SHOTS}/cross-tab-discard-tab-b.png` });

  await context.close();
});

test("tab B keeps text typed after the conflicted save when tab A discards that save", async ({ browser }) => {
  test.setTimeout(90_000);
  const tq = await pickRow(1);
  const server = tq.question ?? "";
  const { context } = await newUserContext(browser, "cross-tab-discard-keep");
  const { a, b } = await conflictInB(context, tq, `CROSS TAB SENT ${Date.now()}`);
  // The translator keeps typing in tab B and has not saved yet.
  const newer = `CROSS TAB NEWER ${Date.now()}`;
  await questionField(b, tq.id).fill(newer);
  await expect(saveButton(b, tq.id)).toBeEnabled();

  // Tab B re-reads the row once it hears the discard; wait for that, so the
  // check below cannot pass before the rebuild has run.
  const reread = b.waitForResponse(
    (r) => r.request().method() === "GET" && r.url().includes(`/api/rows/tq/${tq.id}`),
  );
  await discardConflict(a);
  await expect(questionField(a, tq.id)).toHaveValue(server);
  await reread;
  await b.waitForTimeout(500);

  // Tab B still shows the newer typing, as unsaved against the server's row.
  await expect(questionField(b, tq.id)).toHaveValue(newer);
  await expect(saveButton(b, tq.id)).toBeEnabled();
  if (SHOTS) await b.screenshot({ path: `${SHOTS}/cross-tab-discard-keeps-typing-tab-b.png` });

  await context.close();
});
