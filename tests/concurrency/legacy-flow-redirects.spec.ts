import { expect, test, type Page } from "@playwright/test";
import { newUserContext } from "./helpers";

// Retired flows routes (#173).
//
// The old flows screens (home, scripture, align, articles, words, setup, team)
// and their pill-bar nav were deleted. Their hashes must still land somewhere
// real: each one is rewritten to the screen that does that job now. This spec
// loads every old hash and asserts the URL it settles on and that a screen
// rendered (a heading or real text, no uncaught page error). It also loads every
// entry point that survives (hub surfaces, desk tools, classic menu targets) so
// a route left pointing at a deleted screen shows up as a blank page here.
//
// Signs in as "dev", the SUPER_ADMINS user in api/.dev.vars, so the admin desk
// pages render instead of a permission notice.

const redirects: [from: string, to: string][] = [
  ["#/home", "#/books"],
  ["#/setup", "#/admin/setup"],
  ["#/team", "#/admin/team"],
  ["#/articles", "#/articles/tw"],
  ["#/scripture", "#/books"],
  ["#/align", "#/books"],
  ["#/words", "#/books"],
  ["#/align/ZEC", "#/alignment/ZEC/1"],
  ["#/align/ZEC/6/3", "#/alignment/ZEC/6/3"],
  ["#/words/ZEC/6", "#/verse/ZEC/6/1"],
  ["#/words/ZEC/6/3?row=abc", "#/verse/ZEC/6/3"],
];

// Every surviving destination reachable from the package hub, the admin desk
// rail (including More tools), and the classic top bar / account menu.
const kept = [
  "#/books",
  "#/books/ZEC",
  "#/package/ZEC",
  "#/scripture/ZEC/1",
  "#/scripture/ZEC/6/3",
  "#/notes/ZEC/1",
  "#/questions/ZEC/1",
  "#/alignment/ZEC/1",
  "#/alignment/ZEC/1/1/dual",
  "#/verse/ZEC/1/1",
  "#/words/ZEC",
  "#/admin/progress",
  "#/admin/workflow",
  "#/admin/review",
  "#/admin/team",
  "#/admin/setup",
  "#/ai",
  "#/style",
  "#/curate",
  "#/observe",
  "#/articles/tw",
  "#/templates",
  "#/preferences",
  "#/review/ZEC/1",
  "#/ZEC/1",
];

async function expectRendered(page: Page) {
  // A screen is "rendered" when it shows real text beyond the global chrome
  // strip — not the Suspense spinner, not an empty box.
  await expect
    .poll(
      async () => (await page.locator("body").innerText()).replace(/\s+/g, " ").trim().length,
      { timeout: 20_000 },
    )
    .toBeGreaterThan(80);
  await expect(page.locator(".MuiCircularProgress-root")).toHaveCount(0, { timeout: 20_000 });
}

test.describe("retired flows routes (#173)", () => {
  for (const [from, to] of redirects) {
    test(`${from} lands on ${to}`, async ({ browser }) => {
      const { context } = await newUserContext(browser, "dev");
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`/${from}`);
      await expect.poll(() => new URL(page.url()).hash, { timeout: 15_000 }).toBe(to);
      await expectRendered(page);
      expect(errors, errors.join("\n")).toEqual([]);
      await context.close();
    });
  }

  for (const hash of kept) {
    test(`${hash} still renders`, async ({ browser }) => {
      const { context } = await newUserContext(browser, "dev");
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`/${hash}`);
      await expectRendered(page);
      expect(new URL(page.url()).hash).toBe(hash);
      expect(errors, errors.join("\n")).toEqual([]);
      await context.close();
    });
  }
});
