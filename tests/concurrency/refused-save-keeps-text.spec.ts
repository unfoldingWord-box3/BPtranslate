import { expect, test, request as apiRequest, type Page } from "@playwright/test";
import { fetchChapter, gotoVerse, mintToken, newUserContext, noteTextarea, saveNote } from "./helpers";

// Honor BE_BASE_URL so the suite runs on a relocated port (mirrors s8).
const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";

// Issue #647. When a classic editor's save is refused (a fatal 4xx, or a 409
// "chapter_locked" that the outbox drops), the typed text must still be kept
// somewhere: on screen, in the drafts store (so "N unsaved" shows), and across
// a remount and a reload. Before the fix the tQ table cleared its draft at
// Save (its fields then equal the optimistically patched row), so a refused
// save left the text only in React state.
//
// Refused PATCHes are answered by page.route and never reach the server. The
// saves meant to succeed (the final save in the refusal cases, the response
// save, the superseding save) do write to a ZEC 9 tQ row on the local server;
// globalSetup re-imports ZEC each run. ZEC 9 is used because no other spec
// writes to it.
const CHAPTER = 9;

interface TqRow {
  id: string;
  verse: number;
  question: string | null;
  version: number;
}

interface NoteRow {
  id: string;
  verse: number;
  note: string | null;
}

async function pickRows(): Promise<{ tq: TqRow; tn: NoteRow }> {
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const auth = await mintToken(probe, "probe-647");
  const chapter = await fetchChapter(probe, auth.token, "ZEC", CHAPTER);
  await probe.dispose();
  const tq = (chapter.tq as TqRow[]).find((r) => r.verse > 1);
  const tn = (chapter.tn as NoteRow[]).find((r) => r.verse > 1);
  expect(tq, `expected a tQ row after verse 1 on ZEC ${CHAPTER}`).toBeTruthy();
  expect(tn, `expected a tN row after verse 1 on ZEC ${CHAPTER}`).toBeTruthy();
  return { tq: tq!, tn: tn! };
}

// The row draft's patch as stored in IndexedDB, searched across every
// "bible-editor-drafts*" database (the name carries a workspace suffix; see
// s7's note on why a fixed name is wrong). Opens only databases that exist.
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

function questionField(page: Page, id: string) {
  // MUI multiline renders a hidden mirror textarea; the real one is first of
  // the visible ones (question, then response).
  return page.locator(`[data-question-id="${id}"]`).locator('textarea:not([aria-hidden="true"])').first();
}

function responseField(page: Page, id: string) {
  return page.locator(`[data-question-id="${id}"]`).locator('textarea:not([aria-hidden="true"])').nth(1);
}

// "N unsaved" sits in the top bar's status chip, unless a failed save (the
// fatal case, `failedShown`) takes the chip's label; then it is in the chip's
// popover. Waiting assertions only, so a late render cannot pick the wrong path.
async function expectOneUnsaved(page: Page, failedShown: boolean) {
  const unsaved = page.getByText(/^1 unsaved$/).first();
  if (failedShown) {
    const failed = page.getByText(/^1 failed$/).first();
    await expect(failed).toBeVisible();
    await failed.click();
  }
  await expect(unsaved).toBeVisible();
  await page.keyboard.press("Escape");
}

async function saveQuestion(page: Page, id: string) {
  await page.locator(`[data-question-id="${id}"]`).locator('button:has([data-testid="SaveIcon"])').click();
}

const refusals = [
  {
    name: "a fatal 422",
    status: 422,
    body: { error: "validation_failed" },
  },
  {
    name: 'a "locked" 409',
    status: 409,
    body: { error: "chapter_locked", jobId: "job-647", pipelineType: "translate", startedAt: 1 },
  },
];

for (const refusal of refusals) {
  test(`tQ table: text refused with ${refusal.name} stays on screen, in drafts, and across remount and reload`, async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const { tq } = await pickRows();
    const key = `row:tq:ZEC:${tq.id}`;
    const { context } = await newUserContext(browser, `refused-tq-${refusal.status}`);
    const page = await context.newPage();

    let refused = 0;
    await context.route(`**/api/rows/tq/${tq.id}**`, async (route, request) => {
      if (request.method() !== "PATCH") return route.continue();
      refused++;
      await route.fulfill({ status: refusal.status, contentType: "application/json", body: JSON.stringify(refusal.body) });
    });

    await openQuestions(page, tq.verse);
    const typed = `REFUSED ${refusal.status} ${Date.now()}`;
    await questionField(page, tq.id).fill(typed);
    await saveQuestion(page, tq.id);
    await expect.poll(() => refused, { message: "the PATCH should reach the route" }).toBeGreaterThan(0);

    // Still on screen, and kept in the drafts store as unsaved text.
    await expect(questionField(page, tq.id)).toHaveValue(typed);
    await expect
      .poll(() => readDraftPatch(page, key), { message: "the refused text should be in the drafts store" })
      .toEqual(expect.objectContaining({ question: typed }));
    await expectOneUnsaved(page, refusal.status === 422);

    // A remount without a reload (chapter away and back) must not clear it.
    await page.evaluate(() => {
      location.hash = "#/ZEC/8/2";
    });
    await page.locator(`[data-question-id="${tq.id}"]`).waitFor({ state: "detached", timeout: 10_000 });
    await page.waitForTimeout(500);
    await page.evaluate((v) => {
      location.hash = `#/ZEC/9/${v}`;
    }, tq.verse);
    await expect(questionField(page, tq.id)).toHaveValue(typed);
    expect(await readDraftPatch(page, key)).toEqual(expect.objectContaining({ question: typed }));

    // A reload restores it from the drafts store (the server never got it).
    await page.reload();
    await page.getByRole("button", { name: /^Questions/ }).click();
    await expect(questionField(page, tq.id)).toHaveValue(typed);
    await expectOneUnsaved(page, refusal.status === 422);

    // A later successful save clears the restored draft.
    await context.unroute(`**/api/rows/tq/${tq.id}**`);
    await saveQuestion(page, tq.id);
    await expect.poll(() => readDraftPatch(page, key), { message: "a 200 should clear the draft" }).toBeNull();

    await context.close();
  });
}

test("tQ table: a refused save does not overwrite text typed after it", async ({ browser }) => {
  test.setTimeout(60_000);
  const { tq } = await pickRows();
  const key = `row:tq:ZEC:${tq.id}`;
  const { context } = await newUserContext(browser, "refused-tq-newer");
  const page = await context.newPage();

  // Hold the PATCH until the newer text is typed, then refuse it.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let seen = 0;
  await context.route(`**/api/rows/tq/${tq.id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    seen++;
    await held;
    await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "validation_failed" }) });
  });

  await openQuestions(page, tq.verse);
  const first = `FIRST ${Date.now()}`;
  await questionField(page, tq.id).fill(first);
  await saveQuestion(page, tq.id);
  await expect.poll(() => seen).toBeGreaterThan(0);
  const newer = `${first} NEWER`;
  await questionField(page, tq.id).fill(newer);
  await expect
    .poll(() => readDraftPatch(page, key))
    .toEqual(expect.objectContaining({ question: newer }));
  release();

  // Give the refusal time to land, then check the newer text won.
  await page.waitForTimeout(750);
  await expect(questionField(page, tq.id)).toHaveValue(newer);
  expect(await readDraftPatch(page, key)).toEqual(expect.objectContaining({ question: newer }));

  await context.close();
});

test("tN card: text refused with a fatal 422 survives a reload", async ({ browser }) => {
  test.setTimeout(60_000);
  const { tn } = await pickRows();
  const key = `row:tn:ZEC:${tn.id}`;
  const { context } = await newUserContext(browser, "refused-tn-422");
  const page = await context.newPage();

  let refused = 0;
  await context.route(`**/api/rows/tn/${tn.id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    refused++;
    await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "validation_failed" }) });
  });

  await gotoVerse(page, "ZEC", CHAPTER, tn.verse);
  const typed = `REFUSED NOTE ${Date.now()}`;
  await noteTextarea(page, tn.id).fill(typed);
  await saveNote(page, tn.id);
  await expect.poll(() => refused).toBeGreaterThan(0);

  await expect(noteTextarea(page, tn.id)).toHaveValue(typed);
  await expect.poll(() => readDraftPatch(page, key)).toEqual(expect.objectContaining({ note: typed }));

  await page.reload();
  await expect(noteTextarea(page, tn.id)).toHaveValue(typed);

  await context.close();
});

test("tQ table: a refused question survives editing and saving the response", async ({ browser }) => {
  // Review A1: the editor's diff against the optimistic row is {response}
  // only, so its re-write and the response save's 200 must keep the question.
  test.setTimeout(60_000);
  const { tq } = await pickRows();
  const key = `row:tq:ZEC:${tq.id}`;
  const { context } = await newUserContext(browser, "refused-tq-other-field");
  const page = await context.newPage();

  // Refuse any PATCH that sends the question; let the rest reach the server.
  let refused = 0;
  let passed = 0;
  await context.route(`**/api/rows/tq/${tq.id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    if ("question" in (request.postDataJSON() ?? {})) {
      refused++;
      return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "validation_failed" }) });
    }
    passed++;
    return route.continue();
  });

  await openQuestions(page, tq.verse);
  const typed = `REFUSED Q ${Date.now()}`;
  await questionField(page, tq.id).fill(typed);
  await saveQuestion(page, tq.id);
  await expect.poll(() => refused).toBeGreaterThan(0);
  await expect.poll(() => readDraftPatch(page, key)).toEqual(expect.objectContaining({ question: typed }));

  const response = `RESPONSE ${Date.now()}`;
  await responseField(page, tq.id).fill(response);
  await expect
    .poll(() => readDraftPatch(page, key), { message: "the re-write keeps the refused question" })
    .toEqual({ question: typed, response });
  await saveQuestion(page, tq.id);
  await expect.poll(() => passed, { message: "the response save should reach the server" }).toBeGreaterThan(0);
  await expect
    .poll(() => readDraftPatch(page, key), { message: "the 200 keeps the refused question" })
    .toEqual(expect.objectContaining({ question: typed }));

  await page.reload();
  await page.getByRole("button", { name: /^Questions/ }).click();
  await expect(questionField(page, tq.id)).toHaveValue(typed);
  await expect(responseField(page, tq.id)).toHaveValue(response);
  expect(await readDraftPatch(page, key)).toEqual(expect.objectContaining({ question: typed }));

  await context.close();
});

for (const secondRefused of [false, true]) {
  test(`tQ table: newer text saved over a refused one ${secondRefused ? "and refused too is the text kept" : "wins after a reload"}`, async ({
    browser,
  }) => {
    // Round-2 review B1: refused ABC, then XYZ typed and saved. The refused
    // ABC must not come back over XYZ; if XYZ is refused too, XYZ is kept.
    test.setTimeout(60_000);
    const { tq } = await pickRows();
    const key = `row:tq:ZEC:${tq.id}`;
    const { context } = await newUserContext(browser, `refused-tq-superseded-${secondRefused}`);
    const page = await context.newPage();

    let seen = 0;
    let passed = 0;
    await context.route(`**/api/rows/tq/${tq.id}**`, async (route, request) => {
      if (request.method() !== "PATCH") return route.continue();
      seen++;
      if (seen === 1 || secondRefused) {
        return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "validation_failed" }) });
      }
      passed++;
      return route.continue();
    });

    await openQuestions(page, tq.verse);
    const first = `ABC ${Date.now()}`;
    await questionField(page, tq.id).fill(first);
    await saveQuestion(page, tq.id);
    await expect.poll(() => readDraftPatch(page, key)).toEqual(expect.objectContaining({ question: first }));

    const newer = `XYZ ${Date.now()}`;
    await questionField(page, tq.id).fill(newer);
    await saveQuestion(page, tq.id);
    await expect.poll(() => seen, { message: "the second save should reach the route" }).toBe(2);

    if (secondRefused) {
      await expect
        .poll(() => readDraftPatch(page, key), { message: "the second refusal's text is kept" })
        .toEqual(expect.objectContaining({ question: newer }));
    } else {
      expect(passed).toBe(1);
      await expect
        .poll(() => readDraftPatch(page, key), { message: "no stale refused draft after the 200" })
        .toBeNull();
    }

    await page.reload();
    await page.getByRole("button", { name: /^Questions/ }).click();
    await expect(questionField(page, tq.id)).toHaveValue(newer);
    if (secondRefused) {
      expect(await readDraftPatch(page, key)).toEqual(expect.objectContaining({ question: newer }));
    } else {
      expect(await readDraftPatch(page, key)).toBeNull();
    }

    await context.close();
  });
}
