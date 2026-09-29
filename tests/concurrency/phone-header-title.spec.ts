import { expect, test } from "@playwright/test";
import { newUserContext } from "./helpers";

// Phone header titles (#517).
//
// Since #515 each work screen's title row shares one top bar with the account
// controls. On a phone the title was the only shrinkable child, so it collapsed
// to "Tra…" at 400px and vanished at 360px. The fix shows the passage reference
// ("ZEC 6") as the phone title and drops the secondary header icons below the
// tablet band. This spec pins the two things a translator needs: the reference
// is fully visible (not ellipsized), and no header control runs under the
// account/status toolbar. Screenshots at each width stay the visual check
// (CLAUDE.md); this guards the layout numerically.

const ROUTES = [
  "#/notes/ZEC/6",
  "#/questions/ZEC/6",
  "#/scripture/ZEC/6",
  "#/alignment/ZEC/6/1",
];

for (const uiLang of ["en", "ar"]) {
  for (const width of [360, 400]) {
    test(`phone header shows the passage reference at ${width}px (${uiLang})`, async ({ browser }) => {
      const { context } = await newUserContext(browser, "dev");
      await context.addInitScript((lang) => {
        try {
          localStorage.setItem("be:uiLang", lang);
        } catch {
          /* ignore */
        }
      }, uiLang);
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 800 });
      try {
        for (const route of ROUTES) {
          await page.goto(`/${route}`);
          const h1 = page.locator("h1").first();
          await expect(h1, route).toHaveText("ZEC 6", { timeout: 15_000 });
          // Every screen's phone title is "ZEC 6", so the text alone can match
          // the previous route's header mid-navigation: poll the layout until
          // it settles instead of reading it once.
          await expect
            .poll(
              () =>
                h1.evaluate((el) => {
                  const r = el.getBoundingClientRect();
                  return { wide: r.width > 40, clipped: el.scrollWidth > el.clientWidth + 1 };
                }),
              { message: `${route}: h1 is at least 40px wide and not ellipsized`, timeout: 10_000 },
            )
            .toEqual({ wide: true, clipped: false });

          // No header control may overlap the account/status toolbar.
          const overlaps = () => page.evaluate(() => {
            const bar = document.querySelector('[role="toolbar"]');
            const row = bar?.previousElementSibling;
            if (!bar || !row) return ["toolbar or header slot not found"];
            const b = bar.getBoundingClientRect();
            const hits: string[] = [];
            row.querySelectorAll("button, h1, p").forEach((el) => {
              const r = el.getBoundingClientRect();
              if (r.width === 0) return;
              if (r.right > b.left + 0.5 && r.left < b.right - 0.5 && r.bottom > b.top && r.top < b.bottom) {
                hits.push(`${el.tagName} "${el.getAttribute("aria-label") ?? el.textContent}"`);
              }
            });
            return hits;
          });
          await expect.poll(overlaps, { message: `${route}: elements under the toolbar`, timeout: 10_000 }).toEqual([]);
        }
      } finally {
        await context.close();
      }
    });
  }
}
