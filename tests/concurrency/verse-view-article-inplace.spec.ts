import { expect, test, type Page } from "@playwright/test";
import { newUserContext } from "./helpers";

// Verse view: tW / tA articles open in place (issue #478).
//
// "Read the translationWords article" / "Read the translationAcademy article"
// on #/verse/... used to be plain anchors to #/articles/..., which unmounted
// the verse screen and dropped the translator into the full article editor.
// They now swap the resource list for a read-only article panel on the same
// screen, with a way back to the list. Door43 is mocked so the spec does not
// depend on the network or on the live article text.

const TW_BODY = "SENTINEL tW body";
const TA_BODY = "SENTINEL tA body for translate/figs-idiom";

async function mockDoor43(page: Page) {
  await page.route("https://git.door43.org/**", (route) => {
    const url = route.request().url();
    if (url.includes("/raw/branch/master/bible/kt/")) {
      return route.fulfill({ status: 200, contentType: "text/plain", body: `# Term\n\n${TW_BODY}\n` });
    }
    if (url.includes("/translate/figs-idiom/01.md")) {
      return route.fulfill({ status: 200, contentType: "text/plain", body: `${TA_BODY}\n` });
    }
    if (url.includes("/translate/figs-idiom/title.md")) {
      return route.fulfill({ status: 200, contentType: "text/plain", body: "Idiom\n" });
    }
    return route.fulfill({ status: 404, body: "not mocked" });
  });
}

function resourceRow(page: Page, tag: string) {
  return page
    .locator("[data-resource-row]")
    .filter({ has: page.locator("[data-resource-col='tag']", { hasText: new RegExp(`^${tag}$`) }) })
    .first();
}

test.describe("verse view in-place articles (#478)", () => {
  for (const width of [390, 1280]) {
    test(`tW and tA articles open in place and close back to the list at ${width}px`, async ({ browser }) => {
      const { context } = await newUserContext(browser, `verse-article-${width}`);
      const page = await context.newPage();
      await mockDoor43(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/#/verse/ZEC/1/1");

      // --- tW, from a word-link row ---
      const twRow = resourceRow(page, "kt");
      await expect(twRow).toBeVisible({ timeout: 15_000 });
      await twRow.click();
      await page.getByText("Read the translationWords article").click();

      const panel = page.locator("[data-verse-article]");
      await expect(panel).toBeVisible();
      await expect(panel.getByText(TW_BODY)).toBeVisible();
      expect(page.url()).toContain("#/verse/ZEC/1/1");
      // The article takes the resource list's place; nothing got a third band.
      await expect(page.locator("[data-resource-row]")).toHaveCount(0);
      // The verse screen stayed mounted, selection included.
      await expect(page.getByText("Read the translationWords article")).toBeVisible();
      // The full editor stays reachable.
      await expect(panel.getByRole("link", { name: "Open in the article editor" })).toHaveAttribute(
        "href",
        /^#\/articles\/tw\/kt%2F[a-z-]+$/,
      );

      await panel.getByRole("button", { name: "Back to the list" }).click();
      await expect(panel).toHaveCount(0);
      await expect(twRow).toBeVisible();
      await expect(twRow).toHaveAttribute("aria-current", "true");
      // Focus goes back to the control that opened the article, not <body>.
      await expect(page.getByRole("button", { name: "Read the translationWords article" })).toBeFocused();

      // Selecting something else closes the article: no stale article beside a
      // new selection.
      await page.getByText("Read the translationWords article").click();
      await expect(panel).toBeVisible();
      await page.locator("[data-original-word]").first().click();
      await expect(panel).toHaveCount(0);
      await expect(page.locator("[data-resource-row]").first()).toBeVisible();
      await expect(twRow).not.toHaveAttribute("aria-current", "true");

      // --- tA, from a note row; Escape closes the panel but keeps the selection ---
      const tnRow = resourceRow(page, "idiom");
      await tnRow.click();
      await page.getByText("Read the translationAcademy article").click();
      await expect(panel).toBeVisible();
      await expect(panel.getByText(TA_BODY)).toBeVisible();
      expect(page.url()).toContain("#/verse/ZEC/1/1");

      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(tnRow).toHaveAttribute("aria-current", "true");

      await context.close();
    });
  }

  // Article direction follows the language the panel actually READS (issue
  // #523): the translationSource's language when one is set, else the
  // project's own direction. The title and the body must agree.
  const cases = [
    {
      name: "Arabic project reading an English translationSource is ltr",
      patch: {
        languageCode: "ar",
        direction: "rtl",
        translationSource: {
          org: "unfoldingWord",
          languageCode: "en",
          repos: { ta: "en_ta", tw: "en_tw" },
        },
      },
      expected: "ltr",
    },
    {
      name: "RTL project with no translationSource is rtl",
      patch: { direction: "rtl", translationSource: null },
      expected: "rtl",
    },
  ] as const;
  for (const c of cases) {
    test(`tA article direction (#523): ${c.name}`, async ({ browser }) => {
      const { context } = await newUserContext(browser, `verse-article-dir-${c.expected}`);
      const page = await context.newPage();
      await mockDoor43(page);
      await page.route("**/api/project-config", async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const res = await route.fetch();
        const json = await res.json();
        json.config = { ...json.config, ...c.patch };
        return route.fulfill({ response: res, json });
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/#/verse/ZEC/1/1");

      const tnRow = resourceRow(page, "idiom");
      await expect(tnRow).toBeVisible({ timeout: 15_000 });
      await tnRow.click();
      await page.getByText("Read the translationAcademy article").click();

      const panel = page.locator("[data-verse-article]");
      const body = panel.getByText(TA_BODY);
      const title = panel.getByText("Idiom", { exact: true });
      await expect(body).toBeVisible();
      await expect(title).toBeVisible();
      const dirOf = (el: Element) => getComputedStyle(el as HTMLElement).direction;
      await expect.poll(() => body.evaluate(dirOf)).toBe(c.expected);
      await expect.poll(() => title.evaluate(dirOf)).toBe(c.expected);

      const shots = process.env.ARTICLE_DIR_SHOTS;
      if (shots) await panel.screenshot({ path: `${shots}/article-${c.expected}.png` });
      // A config refetch can still be in the route when the context closes.
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await context.close();
    });
  }
});
