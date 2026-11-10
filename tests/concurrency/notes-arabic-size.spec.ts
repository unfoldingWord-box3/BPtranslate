import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { fetchChapter, newUserContext, type TnRow } from "./helpers";
import { RTL_FIXTURE } from "./global-setup";

// Arabic text on the notes screen is drawn 1.15x larger than English at the
// same CSS size, because Arabic script reads a size smaller
// (web/src/lib/arabicScriptSize.ts). Covers both layouts: the card view's
// lanes, rapid check's pinned lanes and per-verse group lanes, the target
// note text and its editor. English text in the same places keeps its size.
//
// Read-only. Uses global-setup's RTL fixture: ZEC 6:1's ULT is Arabic and
// its UST English; note f66i (ZEC 6:11) is Arabic, the other notes English.

const SCALE = 1.15;
const { book: BOOK, chapter: CHAPTER } = RTL_FIXTURE;

test.describe.configure({ timeout: 120_000 });

const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of openContexts.splice(0)) await c.close().catch(() => {});
});

type Row = TnRow & { trashed_at?: number | null; support_reference?: string | null };

/** Computed font size in px. */
function px(locator: Locator): Promise<number> {
  return locator.evaluate((el) => parseFloat(getComputedStyle(el as HTMLElement).fontSize));
}

/** The English UST of ZEC 6:1 (first words) and the chapter's notes. */
async function probe(browser: Browser): Promise<{ english: string; rows: Row[] }> {
  const { context, auth } = await newUserContext(browser, "arabic-size-probe");
  openContexts.push(context);
  const chap = await fetchChapter(context.request, auth.token, BOOK, CHAPTER);
  const ust = (chap as unknown as {
    verses?: Record<string, Record<string, { plain_text?: string }>>;
  }).verses?.UST?.[String(RTL_FIXTURE.verse)]?.plain_text;
  expect(ust, "expected an English UST for the fixture verse").toBeTruthy();
  return {
    english: ust!.split(/\s+/).slice(0, 6).join(" "),
    rows: (chap.tn as Row[]).filter((r) => r.trashed_at == null),
  };
}

async function open(browser: Browser, user: string, hashTail: string, rapid: boolean): Promise<Page> {
  const { context } = await newUserContext(browser, user);
  openContexts.push(context);
  await context.addInitScript((on) => {
    try {
      localStorage.setItem("be:notesRapidCheck", String(on));
    } catch {
      /* private mode */
    }
  }, rapid);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route("https://git.door43.org/**", (route) => route.fulfill({ status: 404, body: "not mocked" }));
  await page.goto(`/#/notes/${BOOK}/${CHAPTER}/${hashTail}`);
  return page;
}

/** Arabic is SCALE x the English beside it, and the English kept `englishPx`. */
async function expectScaled(arabic: Locator, english: Locator, englishPx: number, what: string) {
  await expect(arabic, what).toBeVisible({ timeout: 20_000 });
  await expect(english, what).toBeVisible();
  const [a, e] = [await px(arabic), await px(english)];
  expect(e, `${what}: English size unchanged`).toBeCloseTo(englishPx, 2);
  expect(a / e, `${what}: Arabic ${a}px vs English ${e}px`).toBeCloseTo(SCALE, 2);
}

test("card view: the Arabic lane and note are drawn larger, English is unchanged", async ({ browser }) => {
  const { english } = await probe(browser);
  const page = await open(browser, "arabic-size-cards", String(RTL_FIXTURE.verse), false);
  // Lane text is 1.03rem in the card view.
  await expectScaled(
    page.locator('span[dir="auto"]').filter({ hasText: RTL_FIXTURE.arabicUlt }),
    page.locator('span[dir="auto"]').filter({ hasText: english }).first(),
    16.48,
    "card lane",
  );

  // The Arabic note, read-only and in its editor (0.97rem for English).
  await page.goto(`/#/notes/${BOOK}/${CHAPTER}/${RTL_FIXTURE.noteVerse}?row=${RTL_FIXTURE.noteId}`);
  const note = page.locator('[role="button"][dir="auto"]').filter({ hasText: RTL_FIXTURE.arabicNote });
  await expect(note).toBeVisible({ timeout: 20_000 });
  expect(await px(note)).toBeCloseTo(15.52 * SCALE, 2);
  await note.click();
  const editor = page.locator("textarea:not([aria-hidden])").first();
  await expect(editor).toHaveValue(RTL_FIXTURE.arabicNote);
  expect(await px(editor)).toBeCloseTo(15.52 * SCALE, 2);
});

test("rapid check: Arabic lanes, group lanes, note and editor are drawn larger", async ({ browser }) => {
  const { english, rows } = await probe(browser);
  const page = await open(browser, "arabic-size-rapid", String(RTL_FIXTURE.verse), true);
  const list = page.locator("[data-rapid-check]");
  await expect(list).toBeVisible({ timeout: 20_000 });

  // The pinned verse block (0.9375rem lanes).
  const block = page.locator("[data-rapid-verse-block]");
  await expectScaled(
    block.locator('span[dir="auto"]').filter({ hasText: RTL_FIXTURE.arabicUlt }),
    block.locator('span[dir="auto"]').filter({ hasText: english }),
    15,
    "pinned lane",
  );

  // Type-filter mode: the verse group's own lanes.
  const slug = (rows.find((r) => r.verse === RTL_FIXTURE.verse && r.support_reference)?.support_reference ?? "")
    .split("/")
    .pop();
  expect(slug, `ZEC ${CHAPTER}:${RTL_FIXTURE.verse} needs a note with a type`).toBeTruthy();
  await page.locator('[aria-label="Filter notes by type"] [role="combobox"]').click();
  await page.locator(`li[role="option"][title="${slug}"]`).click();
  const group = list.locator(`[data-rapid-lanes="${RTL_FIXTURE.verse}"]`);
  await expectScaled(
    group.locator('[data-rapid-group-lane-text="lit"]'),
    group.locator('[data-rapid-group-lane-text="sim"]'),
    15,
    "group lane",
  );

  // The Arabic note's target cell beside an English one (0.9375rem), then
  // each one's editor (0.97rem).
  await page.goto(`/#/notes/${BOOK}/${CHAPTER}/${RTL_FIXTURE.noteVerse}?row=${RTL_FIXTURE.noteId}`);
  const other = rows.find((r) => r.id !== RTL_FIXTURE.noteId && r.verse === RTL_FIXTURE.noteVerse && r.note);
  expect(other, `ZEC ${CHAPTER}:${RTL_FIXTURE.noteVerse} needs a second, English note`).toBeDefined();
  const arabicCell = list.locator(`[data-rapid-row="${RTL_FIXTURE.noteId}"] span[dir="auto"]`).filter({
    hasText: RTL_FIXTURE.arabicNote,
  });
  const englishCell = list.locator(`[data-rapid-row="${other!.id}"] button span[dir="auto"]`);
  await expectScaled(arabicCell, englishCell, 15, "note cell");

  const editor = list.locator("textarea:not([aria-hidden])").first();
  await arabicCell.click();
  await expect(editor).toHaveValue(RTL_FIXTURE.arabicNote);
  expect(await px(editor)).toBeCloseTo(15.52 * SCALE, 2);
  await englishCell.click();
  await expect(editor).not.toHaveValue(RTL_FIXTURE.arabicNote);
  expect(await px(editor), "English editor unchanged").toBeCloseTo(15.52, 2);
});
