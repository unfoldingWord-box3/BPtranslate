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

// The row draft's patch as stored in IndexedDB (same reader as
// refused-save-keeps-text.spec.ts).
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
    .poll(() => readDraftPatch(page, key), { message: "the quote edit should be in the drafts store" })
    .toEqual(expect.objectContaining({ quote: q1 }));

  // Leave the chapter (the card unmounts), then let the save land.
  await page.evaluate(() => {
    location.hash = "#/ZEC/9/2";
  });
  await page.locator(`[data-note-id="${row.id}"]`).waitFor({ state: "detached", timeout: 10_000 });
  release();
  await waitForServerNote(context.request, auth.token, "ZEC", CHAPTER, row.id, (n) => n === n1);
  // Give the outbox's settle time to run against the stored draft.
  await page.waitForTimeout(1000);

  const after = await readDraftPatch(page, key);
  console.log("draft after the save landed:", JSON.stringify(after));
  expect(after, "the revert to N0 must still be in the draft").toEqual(
    expect.objectContaining({ quote: q1, note: n0 }),
  );

  // Reopen: the card shows N0 (unsaved), not the server's N1.
  await page.evaluate((v) => {
    location.hash = `#/ZEC/10/${v}`;
  }, row.verse);
  await expect(noteTextarea(page, row.id)).toHaveValue(n0);
  await expect(quoteTextarea(page, row.id)).toHaveValue(q1);

  await context.close();
});
