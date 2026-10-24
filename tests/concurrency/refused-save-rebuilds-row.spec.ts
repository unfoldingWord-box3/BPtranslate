import { expect, test, request as apiRequest, type BrowserContext, type Page } from "@playwright/test";
import { fetchChapter, gotoVerse, mintToken, newUserContext } from "./helpers";

// Honor BE_BASE_URL so the suite runs on a relocated port (mirrors s8).
const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";

// Issue #637 item 1. A Save patches the cached row at once. When the server
// never applies it (a fatal 4xx, a 409 "chapter_locked" the outbox drops, or a
// save the user discards), the cached row used to keep the unsaved value until
// a refetch. The classic tQ editor then saw no difference between its fields
// and that row, so its Save stayed disabled until the user typed again (the
// known limit #657 left). Now the cached row goes back to the server's row,
// the editor keeps the refused text on screen as unsaved (Save enabled, kept
// in the drafts store), and a discard shows the server's text with no draft.
//
// Refused requests are answered by page.route and never reach the server. ZEC
// 11 is used because no other spec writes to it; globalSetup re-imports ZEC
// each run.
const CHAPTER = 11;

interface TqRow {
  id: string;
  verse: number;
  question: string | null;
  version: number;
}

async function serverRows(): Promise<TqRow[]> {
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const auth = await mintToken(probe, "probe-637");
  const chapter = await fetchChapter(probe, auth.token, "ZEC", CHAPTER);
  await probe.dispose();
  return chapter.tq as TqRow[];
}

async function pickRow(skip = 0): Promise<TqRow> {
  const rows = (await serverRows()).filter((r) => r.verse > 1);
  expect(rows.length, `expected tQ rows after verse 1 on ZEC ${CHAPTER}`).toBeGreaterThan(skip);
  return rows[skip];
}

async function serverQuestion(id: string): Promise<string | null | undefined> {
  return (await serverRows()).find((r) => r.id === id)?.question;
}

// The row draft's patch as stored in IndexedDB (null when there is none),
// searched across every "bible-editor-drafts*" database.
function readDraftPatch(page: Page, key: string) {
  return page.evaluate(async (k) => {
    try {
      const dbs = (await indexedDB.databases()).filter((d) => (d.name ?? "").startsWith("bible-editor-drafts"));
      for (const meta of dbs) {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open(meta.name!, meta.version);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        try {
          if (!db.objectStoreNames.contains("drafts")) continue;
          const rec = await new Promise<{ payload?: { patch?: Record<string, unknown> } } | undefined>(
            (resolve, reject) => {
              const req = db.transaction("drafts", "readonly").objectStore("drafts").get(k);
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            },
          );
          if (rec) return rec.payload?.patch ?? {};
        } finally {
          db.close();
        }
      }
      return null;
    } catch {
      return null;
    }
  }, key);
}

async function openQuestions(page: Page, verse: number) {
  await gotoVerse(page, "ZEC", CHAPTER, verse);
  await page.getByRole("button", { name: /^Questions/ }).click();
}

function rowBox(page: Page, id: string) {
  return page.locator(`[data-question-id="${id}"]`);
}

function questionField(page: Page, id: string) {
  // MUI multiline renders a hidden mirror textarea; the real one is first of
  // the visible ones (question, then response).
  return rowBox(page, id).locator('textarea:not([aria-hidden="true"])').first();
}

// The enabled Save button (SaveIcon renders only while the row is dirty).
function saveButton(page: Page, id: string) {
  return rowBox(page, id).locator('button:has([data-testid="SaveIcon"])');
}

async function refusePatches(
  context: BrowserContext,
  id: string,
  status: number,
  body: unknown,
  method = "PATCH",
): Promise<() => number> {
  let n = 0;
  await context.route(`**/api/rows/tq/${id}**`, async (route, request) => {
    if (request.method() !== method) return route.continue();
    n++;
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return () => n;
}

test("tQ table: a save refused with a fatal 422 shows as unsaved, Save works again, Discard shows the server text", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const tq = await pickRow();
  const key = `row:tq:ZEC:${tq.id}`;
  const server = tq.question ?? "";
  const { context } = await newUserContext(browser, "rebuild-tq-422");
  const page = await context.newPage();
  const refused = await refusePatches(context, tq.id, 422, { error: "validation_failed" });

  await openQuestions(page, tq.verse);
  const typed = `REFUSED 422 ${Date.now()}`;
  await questionField(page, tq.id).fill(typed);
  await saveButton(page, tq.id).click();
  await expect.poll(refused, { message: "the PATCH should reach the route" }).toBeGreaterThan(0);

  // The text stays on screen and counts as unsaved against the server's row:
  // Save is enabled again, and the drafts store holds the text.
  await expect(saveButton(page, tq.id), "Save should be enabled after the refusal").toBeEnabled();
  await expect(questionField(page, tq.id)).toHaveValue(typed);
  await expect.poll(() => readDraftPatch(page, key)).toEqual(expect.objectContaining({ question: typed }));
  expect(await serverQuestion(tq.id)).toBe(server);

  // Discard the failed save: the server's text comes back and no draft is left.
  await page.getByText(/^1 failed$/).first().click();
  // The failed edit's line (its error, then its Retry and Discard icons).
  const failedLine = page.getByText("http 422", { exact: true }).locator("xpath=../..");
  await failedLine.locator('button:has([data-testid="DeleteOutlineIcon"])').click();
  await page.getByRole("dialog").getByRole("button", { name: /^discard$/i }).click();
  await expect(questionField(page, tq.id)).toHaveValue(server);
  await expect.poll(() => readDraftPatch(page, key), { message: "Discard should leave no draft" }).toBeNull();
  await expect(saveButton(page, tq.id)).toHaveCount(0);

  await context.close();
});

test('tQ table: a save dropped as "locked" shows as unsaved and a later Save lands it', async ({ browser }) => {
  test.setTimeout(60_000);
  const tq = await pickRow();
  const key = `row:tq:ZEC:${tq.id}`;
  const { context } = await newUserContext(browser, "rebuild-tq-locked");
  const page = await context.newPage();
  const refused = await refusePatches(context, tq.id, 409, {
    error: "chapter_locked",
    jobId: "job-637",
    pipelineType: "translate",
    startedAt: 1,
  });

  await openQuestions(page, tq.verse);
  const typed = `REFUSED LOCKED ${Date.now()}`;
  await questionField(page, tq.id).fill(typed);
  await saveButton(page, tq.id).click();
  await expect.poll(refused, { message: "the PATCH should reach the route" }).toBeGreaterThan(0);

  await expect(saveButton(page, tq.id), "Save should be enabled after the drop").toBeEnabled();
  await expect(questionField(page, tq.id)).toHaveValue(typed);
  await expect.poll(() => readDraftPatch(page, key)).toEqual(expect.objectContaining({ question: typed }));

  // The lock is over: Save sends the kept text and it lands.
  await context.unroute(`**/api/rows/tq/${tq.id}**`);
  await saveButton(page, tq.id).click();
  await expect.poll(() => serverQuestion(tq.id), { message: "the second Save should land" }).toBe(typed);
  await expect.poll(() => readDraftPatch(page, key), { message: "a 200 should clear the draft" }).toBeNull();
  await expect(questionField(page, tq.id)).toHaveValue(typed);

  await context.close();
});

test("tQ table: discarding a conflict that cannot be resolved (keep theirs) shows the server row", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const tq = await pickRow(1);
  const key = `row:tq:ZEC:${tq.id}`;
  const server = (await serverQuestion(tq.id)) ?? "";
  const { context } = await newUserContext(browser, "rebuild-tq-conflict");
  const page = await context.newPage();
  // A 409 with no current row: the outbox holds it as a conflict it cannot
  // re-arm, and the status bar offers only to discard it.
  const refused = await refusePatches(context, tq.id, 409, { error: "version_mismatch" });

  await openQuestions(page, tq.verse);
  const typed = `CONFLICT ${Date.now()}`;
  await questionField(page, tq.id).fill(typed);
  await saveButton(page, tq.id).click();
  await expect.poll(refused, { message: "the PATCH should reach the route" }).toBeGreaterThan(0);

  await page.getByText(/^1 conflict$/).first().click();
  // The button is named by its tooltip; click it by its label text.
  await page.getByText(/^resolve 1 conflict$/).click();
  await page.getByRole("dialog").getByRole("button", { name: /^discard$/i }).click();

  await expect(questionField(page, tq.id)).toHaveValue(server);
  await expect.poll(() => readDraftPatch(page, key), { message: "keep theirs should leave no draft" }).toBeNull();
  await expect(saveButton(page, tq.id)).toHaveCount(0);

  await context.close();
});

test("tQ table: a refused delete brings the row back", async ({ browser }) => {
  test.setTimeout(60_000);
  const tq = await pickRow(2);
  const { context } = await newUserContext(browser, "rebuild-tq-delete");
  const page = await context.newPage();
  const refused = await refusePatches(context, tq.id, 422, { error: "validation_failed" }, "DELETE");

  await openQuestions(page, tq.verse);
  await expect(rowBox(page, tq.id)).toBeVisible();
  await rowBox(page, tq.id).locator('button:has([data-testid="DeleteOutlineIcon"])').click();
  await expect.poll(refused, { message: "the DELETE should reach the route" }).toBeGreaterThan(0);

  await expect(rowBox(page, tq.id), "the row should come back once the delete is refused").toBeVisible();
  await expect(questionField(page, tq.id)).toHaveValue(tq.question ?? "");

  await context.close();
});

test("tN card: a save refused after the card was left keeps its text on screen and in drafts", async ({ browser }) => {
  // The shape of PR #642's F1: a NoteCard with no session open adopts the row's
  // note, so a rebuild to the server's copy would show the old note, and its
  // no-diff clear would then drop the draft.
  test.setTimeout(60_000);
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const auth = await mintToken(probe, "probe-637-tn");
  const chapter = await fetchChapter(probe, auth.token, "ZEC", CHAPTER);
  await probe.dispose();
  const notes = chapter.tn as Array<{ id: string; verse: number; note: string | null }>;
  const byVerse = new Map<number, typeof notes>();
  for (const n of notes) if (n.verse > 1) byVerse.set(n.verse, [...(byVerse.get(n.verse) ?? []), n]);
  const pair = [...byVerse.values()].find((list) => list.length >= 2);
  expect(pair, `expected a verse with two tN rows on ZEC ${CHAPTER}`).toBeTruthy();
  const [tn, other] = pair!;
  const key = `row:tn:ZEC:${tn.id}`;

  const { context } = await newUserContext(browser, "rebuild-tn-left");
  const page = await context.newPage();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let seen = 0;
  await context.route(`**/api/rows/tn/${tn.id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    seen++;
    await held;
    await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "validation_failed" }) });
  });

  await gotoVerse(page, "ZEC", CHAPTER, tn.verse);
  const note = (id: string) =>
    page.locator(`[data-note-id="${id}"]`).locator('textarea:not([aria-hidden="true"])').nth(1);
  const typed = `REFUSED NOTE ${Date.now()}`;
  await note(tn.id).fill(typed);
  await page.locator(`[data-note-id="${tn.id}"]`).locator('button:has([data-testid="SaveIcon"])').click();
  await expect.poll(() => seen).toBeGreaterThan(0);
  // Leave the card for another note, then let the refusal arrive.
  await note(other.id).click();
  release();

  await page.waitForTimeout(1500);
  await expect(note(tn.id)).toHaveValue(typed);
  await expect.poll(() => readDraftPatch(page, key)).toEqual(expect.objectContaining({ note: typed }));

  await context.close();
});
