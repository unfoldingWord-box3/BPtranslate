import { expect, test, request as apiRequest, type Page } from "@playwright/test";
import { fetchChapter, gotoVerse, mintToken, newUserContext, noteTextarea, saveNote, waitForServerNote } from "./helpers";

// Honor BE_BASE_URL so the suite runs on a relocated port (mirrors s8).
const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";

// Issue #632 item 2. Baseline {quote: Q0, note: N0}. Save {note: N1}; while
// that save is pending, type the note back to N0 and edit the quote, then
// leave the chapter. When the save lands, the reopened card must still show
// N0 as unsaved typing. Before the fix the card's draft held only the quote
// (N0 equals the card's pre-save baseline), the 200 rebased the baseline to
// N1, and the reopened card showed the server's N1 as clean: the revert was
// lost with no unsaved marker.
//
// The PATCH is held by page.route and then passed on to the local server, so
// the save really lands. ZEC 10 is used because no other spec writes to it;
// globalSetup re-imports ZEC each run.
const CHAPTER = 10;

interface NoteRow {
  id: string;
  verse: number;
  note: string | null;
  quote: string | null;
}

async function pickRow(): Promise<NoteRow> {
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const auth = await mintToken(probe, "probe-632");
  const chapter = await fetchChapter(probe, auth.token, "ZEC", CHAPTER);
  await probe.dispose();
  const row = (chapter.tn as unknown as NoteRow[]).find(
    (r) => r.verse > 1 && !!r.note && !r.note.includes("\\n") && !!r.quote,
  );
  expect(row, `expected a one-line tN row with a quote after verse 1 on ZEC ${CHAPTER}`).toBeTruthy();
  return row!;
}

// The row draft's payload ({patch, baseline}) as stored in IndexedDB (same
// lookup as refused-save-keeps-text.spec.ts).
type DraftPayload = { patch?: Record<string, unknown>; baseline?: Record<string, unknown> };
function readDraft(page: Page, key: string) {
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
          const rec = await new Promise<{ payload?: DraftPayload } | undefined>((resolve, reject) => {
            const req = db.transaction("drafts", "readonly").objectStore("drafts").get(k);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          if (rec) return rec.payload ?? {};
        } finally {
          db.close();
        }
      }
      return null;
    } catch {
      return null;
    }
  }, key) as Promise<DraftPayload | null>;
}

function quoteTextarea(page: Page, rowId: string) {
  return page.locator(`[data-note-id="${rowId}"]`).locator('textarea:not([aria-hidden="true"])').first();
}

test("tN card: a note typed back during a pending save, plus a quote edit, survives the save landing", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const row = await pickRow();
  const key = `row:tn:ZEC:${row.id}`;
  const { context, auth } = await newUserContext(browser, "typeback-632");
  const page = await context.newPage();

  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let seen = 0;
  await context.route(`**/api/rows/tn/${row.id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    seen++;
    await held;
    await route.continue();
  });

  try {
    await gotoVerse(page, "ZEC", CHAPTER, row.verse);
    const n0 = await noteTextarea(page, row.id).inputValue();
    const q0 = await quoteTextarea(page, row.id).inputValue();
    const n1 = `${n0} SAVED ${Date.now()}`;
    await noteTextarea(page, row.id).fill(n1);
    await saveNote(page, row.id);
    await expect.poll(() => seen, { message: "the PATCH should reach the route" }).toBeGreaterThan(0);

    // While the save is held: note back to N0, quote edited.
    const q1 = `${q0} EDITED`;
    await noteTextarea(page, row.id).fill(n0);
    await quoteTextarea(page, row.id).fill(q1);
    await expect
      .poll(async () => (await readDraft(page, key))?.patch, { message: "the quote edit should be in the drafts store" })
      .toEqual(expect.objectContaining({ quote: q1 }));

    // Leave the chapter (the card unmounts), then let the save land.
    await page.evaluate(() => {
      location.hash = "#/ZEC/9/2";
    });
    await page.locator(`[data-note-id="${row.id}"]`).waitFor({ state: "detached", timeout: 10_000 });
    release();
    await waitForServerNote(context.request, auth.token, "ZEC", CHAPTER, row.id, (n) => n === n1);
    // The outbox's settle ran once the draft's baseline holds the saved N1.
    await expect
      .poll(async () => (await readDraft(page, key))?.baseline?.note, { message: "the settle should rebase the baseline" })
      .toBe(n1);

    const after = await readDraft(page, key);
    console.log("draft after the save landed:", JSON.stringify(after?.patch));
    expect(after?.patch, "the revert to N0 must still be in the draft").toEqual(
      expect.objectContaining({ quote: q1, note: n0 }),
    );

    // Reopen: the card shows N0 marked unsaved, not the server's N1 as clean.
    await page.evaluate((v) => {
      location.hash = `#/ZEC/10/${v}`;
    }, row.verse);
    await expect(noteTextarea(page, row.id)).toHaveValue(n0);
    await expect(quoteTextarea(page, row.id)).toHaveValue(q1);
    await expect(
      noteTextarea(page, row.id).locator('xpath=ancestor::*[@data-dirty="true"][1]'),
      "the note field should be marked dirty",
    ).toHaveCount(1);
  } finally {
    release();
    await context.close();
  }
});

// Issue #658. Same as above, but the card remounts between the type-back and
// the quote edit: leave the chapter and come back while the save is still
// held. The new card starts with none of the old card's memory of its pending
// save, so before the fix the quote edit replaced the draft with {quote} only,
// the 200 rebased the baseline to N1, and the reopened card showed the
// server's N1 as clean.
test("tN card: a note typed back during a pending save survives a remount before the save lands", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const row = await pickRow();
  const key = `row:tn:ZEC:${row.id}`;
  const { context, auth } = await newUserContext(browser, "typeback-658");
  const page = await context.newPage();

  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let seen = 0;
  await context.route(`**/api/rows/tn/${row.id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    seen++;
    await held;
    await route.continue();
  });

  const leave = async () => {
    await page.evaluate(() => {
      location.hash = "#/ZEC/9/2";
    });
    await page.locator(`[data-note-id="${row.id}"]`).waitFor({ state: "detached", timeout: 10_000 });
  };
  const reopen = async () => {
    await page.evaluate((v) => {
      location.hash = `#/ZEC/10/${v}`;
    }, row.verse);
    await noteTextarea(page, row.id).waitFor({ timeout: 10_000 });
  };

  try {
    await gotoVerse(page, "ZEC", CHAPTER, row.verse);
    const n0 = await noteTextarea(page, row.id).inputValue();
    const q0 = await quoteTextarea(page, row.id).inputValue();
    const n1 = `${n0} SAVED ${Date.now()}`;
    await noteTextarea(page, row.id).fill(n1);
    await saveNote(page, row.id);
    await expect.poll(() => seen, { message: "the PATCH should reach the route" }).toBeGreaterThan(0);

    // While the save is held: note back to N0, recorded in the draft.
    await noteTextarea(page, row.id).fill(n0);
    await expect
      .poll(async () => (await readDraft(page, key))?.patch, { message: "the type-back should be in the drafts store" })
      .toEqual(expect.objectContaining({ note: n0 }));

    // Remount the card with the save still held, then edit the quote.
    await leave();
    await reopen();
    await expect(noteTextarea(page, row.id)).toHaveValue(n0);
    const q1 = `${q0} EDITED`;
    await quoteTextarea(page, row.id).fill(q1);
    await expect
      .poll(async () => (await readDraft(page, key))?.patch, { message: "the quote edit should be in the drafts store" })
      .toEqual(expect.objectContaining({ quote: q1 }));
    console.log("draft after the remount and quote edit:", JSON.stringify((await readDraft(page, key))?.patch));

    // Leave, then let the save land.
    await leave();
    release();
    await waitForServerNote(context.request, auth.token, "ZEC", CHAPTER, row.id, (n) => n === n1);
    await expect
      .poll(async () => (await readDraft(page, key))?.baseline?.note, { message: "the settle should rebase the baseline" })
      .toBe(n1);

    const after = await readDraft(page, key);
    console.log("draft after the save landed:", JSON.stringify(after?.patch));
    expect(after?.patch, "the revert to N0 must still be in the draft").toEqual(
      expect.objectContaining({ quote: q1, note: n0 }),
    );

    await reopen();
    await expect(noteTextarea(page, row.id)).toHaveValue(n0);
    await expect(quoteTextarea(page, row.id)).toHaveValue(q1);
    await expect(
      noteTextarea(page, row.id).locator('xpath=ancestor::*[@data-dirty="true"][1]'),
      "the note field should be marked dirty",
    ).toHaveCount(1);
  } finally {
    release();
    await context.close();
  }
});

// Review A1: when the held save is refused instead, the server keeps N0, so
// the typed-back note equals it and must not linger as a phantom "unsaved"
// field; only the quote edit stays in the draft.
test("tN card: a note typed back during a save that is then refused leaves no phantom", async ({ browser }) => {
  test.setTimeout(60_000);
  const row = await pickRow();
  const key = `row:tn:ZEC:${row.id}`;
  const { context } = await newUserContext(browser, "typeback-632-refused");
  const page = await context.newPage();

  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let seen = 0;
  await context.route(`**/api/rows/tn/${row.id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    seen++;
    await held;
    await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "validation_failed" }) });
  });

  try {
    await gotoVerse(page, "ZEC", CHAPTER, row.verse);
    const n0 = await noteTextarea(page, row.id).inputValue();
    const q0 = await quoteTextarea(page, row.id).inputValue();
    await noteTextarea(page, row.id).fill(`${n0} REFUSED ${Date.now()}`);
    await saveNote(page, row.id);
    await expect.poll(() => seen, { message: "the PATCH should reach the route" }).toBeGreaterThan(0);

    const q1 = `${q0} EDITED`;
    await noteTextarea(page, row.id).fill(n0);
    await quoteTextarea(page, row.id).fill(q1);
    await expect
      .poll(async () => (await readDraft(page, key))?.patch)
      .toEqual(expect.objectContaining({ quote: q1, note: n0 }));

    release();
    await expect
      .poll(async () => (await readDraft(page, key))?.patch, { message: "the refusal should end the protection" })
      .toEqual({ quote: q1 });
    await expect(noteTextarea(page, row.id).locator('xpath=ancestor::*[@data-dirty="true"][1]')).toHaveCount(0);
  } finally {
    release();
    await context.close();
  }
});

// #658, flows Translate Notes: the same type-back, then leave the screen and
// come back while the save is held. Before the fix the returning screen saw
// the note equal to its baseline and cleared the draft at once, so the save's
// 200 left the server's N1 showing as clean.
test("flows notes: a note typed back during a pending save survives leaving and returning", async ({ browser }) => {
  test.setTimeout(90_000);
  const row = await pickRow();
  const key = `row:tn:ZEC:${row.id}`;
  const { context, auth } = await newUserContext(browser, "typeback-658-flows");
  const page = await context.newPage();

  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let seen = 0;
  await context.route(`**/api/rows/tn/${row.id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    seen++;
    await held;
    await route.continue();
  });

  const shown = () => page.locator('[role="button"][dir="auto"]').first();
  const editor = () => page.locator('textarea:not([aria-hidden="true"])').first();
  const open = async () => {
    await page.evaluate((v) => {
      location.hash = `#/notes/ZEC/10/${v}`;
    }, row.verse);
  };
  const leave = async () => {
    await page.evaluate(() => {
      location.hash = "#/ZEC/9/2";
    });
    await page.locator('[role="button"][dir="auto"]').first().waitFor({ state: "detached", timeout: 10_000 });
  };

  try {
    await page.goto(`/#/notes/ZEC/10/${row.verse}`);
    // The tests above may have saved this row already; read what the screen shows.
    await expect(shown()).not.toHaveText("", { timeout: 15_000 });
    const start = await shown().innerText();
    const n1 = `${start} SAVED ${Date.now()}`;
    await shown().click();
    await editor().fill(n1);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => seen, { message: "the PATCH should reach the route" }).toBeGreaterThan(0);

    await editor().fill(start);
    await expect
      .poll(async () => (await readDraft(page, key))?.patch, { message: "the type-back should be in the drafts store" })
      .toEqual({ note: start });

    // Leave and come back with the save still held.
    await leave();
    await open();
    await expect(shown()).toHaveText(start, { timeout: 15_000 });
    // Give the returning screen's persist effect its pass.
    await page.waitForTimeout(500);
    expect((await readDraft(page, key))?.patch, "the returning screen must keep the type-back").toEqual({ note: start });

    await leave();
    release();
    await waitForServerNote(context.request, auth.token, "ZEC", CHAPTER, row.id, (n) => n === n1);
    await expect
      .poll(async () => (await readDraft(page, key))?.baseline?.note, { message: "the settle should rebase the baseline" })
      .toBe(n1);
    expect((await readDraft(page, key))?.patch, "the revert must still be in the draft").toEqual({ note: start });

    await open();
    await expect(shown()).toHaveText(start, { timeout: 15_000 });
  } finally {
    release();
    await context.close();
  }
});

// #658, refused after the remount: the protection the remounted card recovered
// from the outbox must end with that save, like the one the original card
// held, so the typed-back note leaves the draft (the server kept it).
test("tN card: after a remount, a type-back protection ends when the save is refused", async ({ browser }) => {
  test.setTimeout(90_000);
  const row = await pickRow();
  const key = `row:tn:ZEC:${row.id}`;
  const { context } = await newUserContext(browser, "typeback-658-refused");
  const page = await context.newPage();

  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let seen = 0;
  await context.route(`**/api/rows/tn/${row.id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    seen++;
    await held;
    await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "validation_failed" }) });
  });

  try {
    await gotoVerse(page, "ZEC", CHAPTER, row.verse);
    const n0 = await noteTextarea(page, row.id).inputValue();
    const q0 = await quoteTextarea(page, row.id).inputValue();
    await noteTextarea(page, row.id).fill(`${n0} REFUSED ${Date.now()}`);
    await saveNote(page, row.id);
    await expect.poll(() => seen, { message: "the PATCH should reach the route" }).toBeGreaterThan(0);
    await noteTextarea(page, row.id).fill(n0);
    await expect.poll(async () => (await readDraft(page, key))?.patch).toEqual(expect.objectContaining({ note: n0 }));

    // Remount with the save still held.
    await page.evaluate(() => {
      location.hash = "#/ZEC/9/2";
    });
    await page.locator(`[data-note-id="${row.id}"]`).waitFor({ state: "detached", timeout: 10_000 });
    await page.evaluate((v) => {
      location.hash = `#/ZEC/10/${v}`;
    }, row.verse);
    await expect(noteTextarea(page, row.id)).toHaveValue(n0);
    const q1 = `${q0} EDITED`;
    await quoteTextarea(page, row.id).fill(q1);
    await expect
      .poll(async () => (await readDraft(page, key))?.patch, { message: "the remounted card should keep the type-back" })
      .toEqual({ quote: q1, note: n0 });

    release();
    await expect
      .poll(async () => (await readDraft(page, key))?.patch, { message: "the refusal should end the recovered protection" })
      .toEqual({ quote: q1 });
    await expect(noteTextarea(page, row.id).locator('xpath=ancestor::*[@data-dirty="true"][1]')).toHaveCount(0);
  } finally {
    release();
    await context.close();
  }
});
