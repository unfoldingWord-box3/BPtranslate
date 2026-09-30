import { expect, test, type Page } from "@playwright/test";
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

// Header problems against the account/status toolbar, as a list (empty = OK).
// Only the part of an element inside the header slot paints when the slot
// clips (App's overflow: hidden), so that clipped rect is what is compared.
// `wholeButtons` also reports any header button cut off at the slot's edge.
function headerProblems(page: Page, wholeButtons: boolean): Promise<string[]> {
  return page.evaluate((wholeButtons) => {
    const bar = document.querySelector('[role="toolbar"]');
    const slot = bar?.previousElementSibling;
    if (!bar || !slot) return ["toolbar or header slot not found"];
    const b = bar.getBoundingClientRect();
    const s = slot.getBoundingClientRect();
    const clips = getComputedStyle(slot).overflowX !== "visible";
    const out: string[] = [];
    slot.querySelectorAll("button, h1, p").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0) return;
      const name = `${el.tagName} "${el.getAttribute("aria-label") ?? el.textContent}"`;
      const left = clips ? Math.max(r.left, s.left) : r.left;
      const right = clips ? Math.min(r.right, s.right) : r.right;
      if (right > b.left + 0.5 && left < b.right - 0.5 && r.bottom > b.top && r.top < b.bottom) {
        out.push(`${name} under the toolbar`);
      }
      if (wholeButtons && el.tagName === "BUTTON" && (r.left < s.left - 0.5 || r.right > s.right + 0.5)) {
        out.push(`${name} cut off`);
      }
    });
    return out;
  }, wholeButtons);
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

          // No header control may paint under the account/status toolbar.
          const overlaps = () => headerProblems(page, false);
          await expect.poll(overlaps, { message: `${route}: elements under the toolbar`, timeout: 10_000 }).toEqual([]);
        }
      } finally {
        await context.close();
      }
    });
  }
}

// Wide toolbar (#517 review). The toolbar grows past its idle width when there
// is unsaved typing and the connection drops: a "1 unsaved" chip plus an
// "offline" chip, 224px (en) / 245px (ar) wide. At 360px that left the header
// slot 136px / 115px, less than the ~176px the row needed with the passage
// reference held at full width, so the prev/next buttons painted under the
// toolbar. The row must give way instead: the count first, then the caption,
// then the reference, and whatever still does not fit is cut off at the slot's
// edge rather than drawn under the toolbar.
//
// `wholeButtons`: the back and prev/next buttons also stay fully visible. Not
// asserted for Arabic at 360px, where even the fully shrunk row (~122px) is
// ~7px wider than the slot, so the far-end next button is clipped slightly;
// fitting that needs the toolbar's chips to get more compact on phones.
const WIDE_CASES: [string, number, boolean][] = [
  ["en", 360, true],
  ["en", 400, true],
  ["ar", 360, false],
  ["ar", 400, true],
];
for (const [uiLang, width, wholeButtons] of WIDE_CASES) {
  test(`phone header gives way to a wide toolbar at ${width}px (${uiLang})`, async ({ browser }) => {
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
      for (const [index, [route, captionKey]] of ROUTES.entries()) {
        await page.goto(`/${route}`);
        await expect(page.locator("h1 + p").first(), `${route}: caption`).toHaveText(
          screenName(uiLang, captionKey),
          { timeout: 15_000 },
        );
        if (index === 0) {
          // An unsaved draft, written through the app's own drafts store (the
          // Vite dev server serves the same module instance the app uses).
          await page.evaluate(async () => {
            const m = await import(/* @vite-ignore */ "/src/sync/drafts.ts");
            await m.drafts.set(m.rowKey("tn", "ZEC", "phone-header-draft"), { note: "draft" }, 1, {
              kind: "row",
              rowKind: "tn",
              id: "phone-header-draft",
              book: "ZEC",
              chapter: 6,
              verse: 1,
            });
          });
        }
        await context.setOffline(true);
        const toolbar = page.locator('[role="toolbar"]');
        // Both chips must be up before measuring, or the case would pass
        // against a narrower toolbar than the one it describes.
        await expect(toolbar, `${route}: unsaved chip`).toContainText(`1 ${screenName(uiLang, "sync.unsaved")}`, {
          timeout: 10_000,
        });
        await expect(toolbar, `${route}: offline chip`).toContainText(screenName(uiLang, "sync.offline"), {
          timeout: 10_000,
        });
        // Measured 224px (en) / 245px (ar) with both chips on agentbox and
        // 210px (en) on CI's fonts; idle is 68px and either chip alone stays
        // under ~155px. 180 proves both chips are counted without tying the
        // case to one machine's font metrics.
        await expect
          .poll(() => toolbar.evaluate((el) => Math.round(el.getBoundingClientRect().width)), {
            message: `${route}: toolbar at its wide width`,
            timeout: 10_000,
          })
          .toBeGreaterThanOrEqual(180);

        const problems = () => headerProblems(page, wholeButtons);
        await expect.poll(problems, { message: `${route}: header vs toolbar`, timeout: 10_000 }).toEqual([]);
        await context.setOffline(false);
      }
    } finally {
      await context.close();
    }
  });
}
