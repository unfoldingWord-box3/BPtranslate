import { expect, test } from "@playwright/test";
import { newUserContext } from "./helpers";

// Verse view chrome + layout guard (issue #477).
//
// The verse view (#/verse/BOOK/CH/VS) used to stack the retired FlowNav pill
// bar, a bespoke toolbar and a hint row, with no page heading at all; and its
// resource list gave every row its own grid, so tags and note text started at
// a different x on each row. Both are layout facts only a real browser can
// see, so this spec asserts them against the seeded ZEC fixture.

test.describe("verse view layout (#477)", () => {
  test("one h1 page title, no FlowNav, resource columns aligned", async ({ browser }) => {
    const { context } = await newUserContext(browser, "verse-layout");
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/#/verse/ZEC/1/1");

    // One header band with a real page heading, like #/notes and #/package.
    await expect(page.locator("h1")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator("h1")).toBeVisible();
    // FlowNav renders <nav aria-label="Screens">; the redesigned screens mount none.
    await expect(page.locator('nav[aria-label="Screens"]')).toHaveCount(0);

    // Resource list: the note text column starts at the same x on every row,
    // whatever the width of that row's tag.
    const texts = page.locator("[data-resource-row] [data-resource-col='text']");
    await expect(texts.first()).toBeVisible({ timeout: 15_000 });
    const xs = await texts.evaluateAll((els) =>
      els.map((el) => Math.round((el as HTMLElement).getBoundingClientRect().left)),
    );
    expect(xs.length, "expected several resource rows for ZEC 1:1").toBeGreaterThan(1);
    expect(new Set(xs).size, `text columns start at ${xs.join(", ")}`).toBe(1);

    await context.close();
  });
});
