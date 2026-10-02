import { expect, test, type Page } from "@playwright/test";
import { newUserContext } from "./helpers";

// Retired flows routes (#173).
//
// The old flows screens (home, scripture, align, articles, words, setup, team)
// and their pill-bar nav were deleted. Their hashes must still land somewhere
// real: each one is rewritten to the screen that does that job now. This spec
// loads every old hash and asserts the URL it settles on and a landmark of the
// destination screen (its heading), with no uncaught page error. It also loads
// every entry point that survives (hub surfaces, desk tools, classic menu
// targets) so a route left pointing at a deleted screen fails here.
//
// Signs in as "dev", the SUPER_ADMINS user in api/.dev.vars, so the admin desk
// pages render instead of a permission notice. Headings are the English UI
// strings (en.json); a renamed heading means updating the table below.

// A heading of the given tag whose text starts with `text`.
type Landmark = { tag: string; text: string | RegExp };
const h1 = (text: string): Landmark => ({ tag: "h1", text });
const h6 = (text: string): Landmark => ({ tag: "h6", text });

const BOOKS = h1("Books");
const CLASSIC_NOTES = h6("Notes");

const redirects: [from: string, to: string, landmark: Landmark][] = [
  ["#/home", "#/books", BOOKS],
  ["#/home/", "#/books", BOOKS],
  ["#/Home?x=1", "#/books", BOOKS],
  ["#/setup", "#/admin/setup", h1("Setup & preferences")],
  ["#/team", "#/admin/team", h1("Team & roles")],
  ["#/articles", "#/articles/tw", h6("Articles")],
  ["#/scripture", "#/books", BOOKS],
  ["#/align", "#/books", BOOKS],
  ["#/words", "#/books", BOOKS],
  ["#/align/ZEC", "#/alignment/ZEC/1", h1("Alignment")],
  ["#/align/ZEC/6/3", "#/alignment/ZEC/6/3", h1("Alignment")],
  ["#/align/ZEC/6/3/", "#/alignment/ZEC/6/3", h1("Alignment")],
  // The old word-links editor → the classic editor at that verse.
  ["#/words/ZEC/6", "#/ZEC/6/1", CLASSIC_NOTES],
  ["#/words/ZEC?row=x", "#/words/ZEC", { tag: "body", text: /Words & Articles/ }],
];

// Every surviving destination reachable from the package hub, the admin desk
// rail (including More tools), and the classic top bar / account menu.
const kept: [hash: string, landmark: Landmark][] = [
  ["#/books", BOOKS],
  ["#/books/ZEC", BOOKS],
  ["#/package/ZEC", h1("Zechariah")],
  ["#/scripture/ZEC/1", h1("Scripture")],
  ["#/scripture/ZEC/6/3", h1("Scripture")],
  ["#/notes/ZEC/1", h1("Translation Notes")],
  ["#/questions/ZEC/1", h1("Translation Questions")],
  ["#/alignment/ZEC/1", h1("Alignment")],
  ["#/alignment/ZEC/1/1/dual", h1("Alignment")],
  ["#/verse/ZEC/1/1", h1("Verse view")],
  ["#/words/ZEC", { tag: "body", text: /Words & Articles/ }],
  ["#/admin/progress", h1("Progress")],
  ["#/admin/workflow", h1("Workflow")],
  ["#/admin/review", h1("Review state")],
  ["#/admin/team", h1("Team & roles")],
  ["#/admin/setup", h1("Setup & preferences")],
  ["#/ai", h1("AI studio")],
  ["#/style", h1("Style")],
  ["#/curate", h1("Templates")],
  ["#/observe", h1("Observe")],
  ["#/articles/tw", h6("Articles")],
  ["#/templates", h6("Note Templates")],
  ["#/preferences", h6("Preferences & Memory")],
  ["#/review/ZEC/1", { tag: "h2", text: "Approve all" }],
  ["#/ZEC/1", CLASSIC_NOTES],
];

async function expectLandmark(page: Page, { tag, text }: Landmark) {
  await expect(page.locator(tag).filter({ hasText: text }).first()).toBeVisible({ timeout: 20_000 });
}

// The ids of the seeded ZEC 6:3 word-link rows (the fixture has two).
async function zec63TwlIds(page: Page): Promise<string[]> {
  const res = await page.request.get("/api/chapters/ZEC/6");
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { twl: { id: string; verse: number }[] };
  const ids = body.twl.filter((r) => r.verse === 3).map((r) => r.id);
  expect(ids.length, "seeded ZEC 6:3 has two word links").toBeGreaterThan(1);
  return ids;
}
const zec63TwlId = async (page: Page) => (await zec63TwlIds(page))[0];

async function expectRowInactive(page: Page, id: string) {
  await expect
    .poll(() => page.locator(`[data-word-id="${id}"]`).evaluate((el) => getComputedStyle(el).boxShadow))
    .not.toContain("inset");
}

// Classic editor opened with ?twl=: the resource column is on its Words tab
// (header "TWLinks", not "Notes") and that row carries the active marker.
async function expectWordsTabWithRow(page: Page, id: string) {
  await expectLandmark(page, h6("TWLinks"));
  const row = page.locator(`[data-word-id="${id}"]`);
  await expect(row).toBeVisible();
  await expect
    .poll(() => row.evaluate((el) => getComputedStyle(el).boxShadow))
    .toContain("inset");
}

test.describe("retired flows routes (#173)", () => {
  for (const [from, to, landmark] of redirects) {
    test(`${from} lands on ${to}`, async ({ browser }) => {
      const { context } = await newUserContext(browser, "dev");
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`/${from}`);
      await expect.poll(() => new URL(page.url()).hash, { timeout: 15_000 }).toBe(to);
      await expectLandmark(page, landmark);
      expect(errors, errors.join("\n")).toEqual([]);
      await context.close();
    });
  }

  for (const [hash, landmark] of kept) {
    test(`${hash} still renders`, async ({ browser }) => {
      const { context } = await newUserContext(browser, "dev");
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`/${hash}`);
      await expectLandmark(page, landmark);
      expect(new URL(page.url()).hash).toBe(hash);
      expect(errors, errors.join("\n")).toEqual([]);
      await context.close();
    });
  }

  test("an old word-link bookmark opens the classic Words tab on that row", async ({ browser }) => {
    const { context } = await newUserContext(browser, "dev");
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const id = await zec63TwlId(page);
    await page.goto(`/#/words/ZEC/6/3?row=${encodeURIComponent(id)}`);
    await expect
      .poll(() => new URL(page.url()).hash, { timeout: 15_000 })
      .toBe(`#/ZEC/6/3?twl=${encodeURIComponent(id)}`);
    await expectWordsTabWithRow(page, id);
    expect(errors, errors.join("\n")).toEqual([]);
    await context.close();
  });

  test("a ?twl= change while the classic editor is mounted selects that row", async ({ browser }) => {
    const { context } = await newUserContext(browser, "dev");
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const [first, second] = await zec63TwlIds(page);
    await page.goto(`/#/ZEC/6/3?twl=${encodeURIComponent(first)}`);
    await expectWordsTabWithRow(page, first);
    // Same book, same verse, only ?twl= changes: no remount, no reload.
    await page.evaluate((id) => {
      location.hash = `#/ZEC/6/3?twl=${encodeURIComponent(id)}`;
    }, second);
    await expectWordsTabWithRow(page, second);
    await expectRowInactive(page, first);
    expect(errors, errors.join("\n")).toEqual([]);
    await context.close();
  });

  test("a ?twl= id with selector characters does not break the editor", async ({ browser }) => {
    const { context } = await newUserContext(browser, "dev");
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/#/ZEC/6/3?twl=%22%5D");
    await expectLandmark(page, h6("TWLinks"));
    await expect(page.locator("[data-word-id]").first()).toBeVisible();
    expect(errors, errors.join("\n")).toEqual([]);
    await context.close();
  });

  test("the redirect keeps the query string (?_choose_ws=1)", async ({ browser }) => {
    const { context } = await newUserContext(browser, "dev");
    const page = await context.newPage();
    await page.goto("/?_choose_ws=1#/home");
    await expect.poll(() => new URL(page.url()).hash, { timeout: 15_000 }).toBe("#/books");
    // The workspace picker only opens when ?_choose_ws survived parseHash.
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15_000 });
    await context.close();
  });
});
