import { expect, test, request as apiRequest, type BrowserContext, type Page } from "@playwright/test";
import { fetchChapter, gotoVerse, mintToken, newUserContext, noteTextarea } from "./helpers";

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

// The row draft's patch as stored in IndexedDB (null when there is none),
// searched across every "bible-editor-drafts*" database (as in
// refused-save-rebuilds-row.spec.ts).
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

// Every PATCH of the row is answered with `answer`. A 409 that carries no
// current row is held as a conflict the outbox cannot re-arm (the status bar
// offers only to discard it); a 422 is a refusal (a failed edit).
const CONFLICT = { status: 409, body: { error: "version_mismatch" } };
const REFUSED = { status: 422, body: { error: "validation_failed" } };
async function answerPatches(
  context: BrowserContext,
  id: string,
  answer: { status: number; body: unknown },
): Promise<() => number> {
  let n = 0;
  await context.route(`**/api/rows/tq/${id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    n++;
    await route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
  });
  return () => n;
}

// Save `typed` in tab B (a 409, or a 422 with `answer`), then open tab A on
// the same chapter, where the status bar lists the edit from the shared outbox.
async function conflictInB(context: BrowserContext, tq: TqRow, typed: string, answer = CONFLICT) {
  const b = await context.newPage();
  const seen = await answerPatches(context, tq.id, answer);
  await openQuestions(b, tq.verse);
  await questionField(b, tq.id).fill(typed);
  await saveButton(b, tq.id).click();
  await expect.poll(seen, { message: "the PATCH should reach the route" }).toBeGreaterThan(0);
  await expect(b.getByText(answer === CONFLICT ? /^1 conflict$/ : /^1 failed$/).first()).toBeVisible();
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

  // Tab B still shows the newer typing, as unsaved against the server's row,
  // and the drafts store still holds it.
  await expect(questionField(b, tq.id)).toHaveValue(newer);
  await expect(saveButton(b, tq.id)).toBeEnabled();
  await expect
    .poll(() => readDraftPatch(b, `row:tq:ZEC:${tq.id}`))
    .toEqual(expect.objectContaining({ question: newer }));
  if (SHOTS) await b.screenshot({ path: `${SHOTS}/cross-tab-discard-keeps-typing-tab-b.png` });

  await context.close();
});

test("a refused save typed in tab B and discarded in tab A: tab B lets go of the refused text", async ({ browser }) => {
  // Tab B's editor holds a refused save's text on screen as unsaved
  // (refusedSaveHold.ts). Discarding that failed edit in tab A ends the hold
  // in tab B as a local Discard does: the server's text comes back, and the
  // drafts store (shared, settled by tab A) holds nothing for the row.
  test.setTimeout(90_000);
  const tq = await pickRow(2);
  const key = `row:tq:ZEC:${tq.id}`;
  const server = tq.question ?? "";
  const { context } = await newUserContext(browser, "cross-tab-discard-failed");
  const typed = `CROSS TAB REFUSED ${Date.now()}`;
  const { a, b } = await conflictInB(context, tq, typed, REFUSED);
  await expect(questionField(b, tq.id)).toHaveValue(typed);
  await expect(saveButton(b, tq.id), "the refused text shows as unsaved").toBeEnabled();

  await a.bringToFront();
  await a.getByText(/^1 failed$/).first().click();
  const failedLine = a.getByText("http 422", { exact: true }).locator("xpath=../..");
  await failedLine.locator('button:has([data-testid="DeleteOutlineIcon"])').click();
  await a.getByRole("dialog").getByRole("button", { name: /^discard$/i }).click();

  await expect(questionField(b, tq.id)).toHaveValue(server);
  await expect(saveButton(b, tq.id)).toHaveCount(0);
  await expect.poll(() => readDraftPatch(b, key), { message: "Discard should leave no draft" }).toBeNull();
  if (SHOTS) await b.screenshot({ path: `${SHOTS}/cross-tab-discard-failed-tab-b.png` });

  await context.close();
});

test("tN card, tab B not draining: a refused save discarded in tab A frees tab B's card", async ({ browser }) => {
  // Review item 1: NoteCard keeps its pending save (sentRef, and the Save gate
  // savePendingVersion) until it hears that save end. Here tab A drains, so
  // tab B never hears the 422; only tab A's Discard can end it. Before, tab B
  // kept the refused note, then (once the row was rebuilt) wrote a stray
  // "reverted" draft and kept Save disabled until a remount.
  test.setTimeout(90_000);
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const auth = await mintToken(probe, "probe-637-tabs-tn");
  const chapter = await fetchChapter(probe, auth.token, "ZEC", CHAPTER);
  await probe.dispose();
  const notes = chapter.tn as Array<{ id: string; verse: number; note: string | null }>;
  const byVerse = new Map<number, typeof notes>();
  for (const n of notes) if (n.verse > 1) byVerse.set(n.verse, [...(byVerse.get(n.verse) ?? []), n]);
  const pair = [...byVerse.values()].find((list) => list.length >= 2);
  expect(pair, `expected a verse with two tN rows on ZEC ${CHAPTER}`).toBeTruthy();
  const [tn, other] = pair!;
  const key = `row:tn:ZEC:${tn.id}`;
  const server = tn.note ?? "";

  const { context } = await newUserContext(browser, "cross-tab-discard-tn");
  let patches = 0;
  const sentFrom: string[] = [];
  let pageA: Page | null = null;
  await context.route(`**/api/rows/tn/${tn.id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    patches++;
    sentFrom.push(request.frame().page() === pageA ? "A" : "B");
    await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify(REFUSED.body) });
  });

  // Tab A opens first and holds the outbox's drain lock, so tab B cannot drain.
  const a = await context.newPage();
  pageA = a;
  await gotoVerse(a, "ZEC", CHAPTER, tn.verse);
  await a.evaluate(
    () =>
      new Promise<void>((held) => {
        void navigator.locks.request("be-outbox-drain", () => {
          held();
          return new Promise<void>((release) => {
            (window as unknown as { __releaseDrain: () => void }).__releaseDrain = release;
          });
        });
      }),
  );

  const b = await context.newPage();
  await gotoVerse(b, "ZEC", CHAPTER, tn.verse);
  const typed = `CROSS TAB NOTE ${Date.now()}`;
  await noteTextarea(b, tn.id).fill(typed);
  const save = b.locator(`[data-note-id="${tn.id}"]`).locator('button:has([data-testid="SaveIcon"])');
  await save.click();
  // Leave the card, so it follows the row (no editing session open).
  await noteTextarea(b, other.id).click();
  await b.waitForTimeout(500);
  expect(patches, "tab B cannot drain while tab A holds the lock").toBe(0);

  // Tab A lets go of the lock and drains at once (a focus drains).
  // The release is async, so wait until the lock is free before the focus,
  // or tab A's drain finds it still held and tab B's 3 s retry wins.
  await a.bringToFront();
  await a.evaluate(async () => {
    (window as unknown as { __releaseDrain: () => void }).__releaseDrain();
    while ((await navigator.locks.query()).held?.some((l) => l.name === "be-outbox-drain")) {
      await new Promise((r) => setTimeout(r, 5));
    }
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => patches, { message: "tab A should send the PATCH" }).toBe(1);
  expect(sentFrom, "tab A should be the one that sent it").toEqual(["A"]);
  await a.getByText(/^1 failed$/).first().click();
  const failedLine = a.getByText("http 422", { exact: true }).locator("xpath=../..");
  await failedLine.locator('button:has([data-testid="DeleteOutlineIcon"])').click();
  await a.getByRole("dialog").getByRole("button", { name: /^discard$/i }).click();

  // Tab B: the card shows the server's note, leaves no draft behind, and its
  // Save works again for new text.
  await expect(noteTextarea(b, tn.id)).toHaveValue(server);
  await b.waitForTimeout(1000);
  expect(await readDraftPatch(b, key), "no stray draft for the row").toBeNull();
  const again = `CROSS TAB NOTE AGAIN ${Date.now()}`;
  await noteTextarea(b, tn.id).fill(again);
  await expect(save, "Save should be enabled for new text").toBeEnabled();
  if (SHOTS) await b.screenshot({ path: `${SHOTS}/cross-tab-discard-tn-tab-b.png` });

  await context.close();
});
