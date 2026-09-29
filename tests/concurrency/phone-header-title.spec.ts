import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

// Each route with the i18n key its phone caption renders (the screen name).
// Every phone h1 reads "ZEC 6", so the caption is the screen-specific signal
// that the NEW screen's header has portalled in, not the previous route's.
const ROUTES: [string, string][] = [
  ["#/notes/ZEC/6", "flowTranslate.title"],
  ["#/questions/ZEC/6", "flowQuestions.title"],
  ["#/scripture/ZEC/6", "flowScripture.title"],
  ["#/alignment/ZEC/6/1", "flowAlign.desk.title"],
];

const LOCALES = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/src/i18n/locales");
function screenName(lang: string, key: string): string {
  const dict = JSON.parse(readFileSync(resolve(LOCALES, `${lang}.json`), "utf8"));
  const value = key.split(".").reduce((node, part) => node?.[part], dict);
  if (typeof value !== "string") throw new Error(`no ${lang} string for ${key}`);
  return value;
}

for (const uiLang of ["en", "ar"]) {
  for (const width of [360, 400]) {
    test(`phone header shows the passage reference at ${width}px (${uiLang})`, async ({ browser }) => {
      // Four routes, each with up to ~35s of waits: the suite's 30s default
      // would fail a correct layout on a cold runner.
      test.setTimeout(120_000);
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
        for (const [route, captionKey] of ROUTES) {
          await page.goto(`/${route}`);
          const h1 = page.locator("h1").first();
          // Wait for THIS screen's header (its caption names the screen) before
          // measuring; the h1 text alone would also match the previous route.
          await expect(page.locator("h1 + p").first(), `${route}: caption`).toHaveText(
            screenName(uiLang, captionKey),
            { timeout: 15_000 },
          );
          await expect(h1, route).toHaveText("ZEC 6");
          // Poll the layout until it settles instead of reading it once.
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
