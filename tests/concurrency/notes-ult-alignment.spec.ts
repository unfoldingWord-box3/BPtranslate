import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mintToken } from "./helpers";

// Flows notes screen: read-only ULT alignment strip (issue #431).
//
// The seeded workspace is an English-root preset, where the source ULT lane
// (#430) is never offered — its lit lane already IS en_ult. So the spec turns
// the project config into a gateway-language translation workspace on the way
// in (mode "translation", translationSource lit = en_ult, as in a BSOJ
// workspace) and serves the Door43 en_ult download from docs/samples.
// Both toggles start on through their localStorage prefs.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EN_ULT = readFileSync(resolve(repoRoot, "docs/samples/en_ult_38-ZEC.usfm"), "utf8");

async function openNotes(browser: Browser, name: string, width: number, touch: boolean, hash: string) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    hasTouch: touch,
    isMobile: touch,
  });
  await mintToken(context.request, name);
  await context.addInitScript(() => {
    try {
      localStorage.setItem("be:showSourceUlt", "true");
      localStorage.setItem("be:showSourceUltAlignment", "true");
    } catch {
      /* private mode */
    }
  });
  const page = await context.newPage();
  await page.route("**/api/project-config", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    body.config = {
      ...body.config,
      mode: "translation",
      // A different org than the project's own, so the screen does not read
      // it as "the lit lane already IS this repo" and hide the toggle.
      translationSource: { org: "Door43-Catalog", repos: { lit: "en_ult" } },
    };
    return route.fulfill({ response: res, json: body });
  });
  await page.route("https://git.door43.org/**", (route) => {
    if (route.request().url().endsWith("/en_ult/raw/branch/master/38-ZEC.usfm")) {
      return route.fulfill({ status: 200, contentType: "text/plain", body: EN_ULT });
    }
    return route.fulfill({ status: 404, body: "not mocked" });
  });
  await page.goto(hash);
  return { context, page };
}

const strip = (page: Page) => page.locator("[data-align-strip]");
const en = (page: Page, word: string) => strip(page).locator(`[data-align-en="${word}"]`).first();
const orig = (page: Page, pos: number) => strip(page).locator(`[data-align-orig="${pos}"]`);
const litOrig = (page: Page) => strip(page).locator("[data-align-orig][data-lit]");
const litEn = (page: Page) => strip(page).locator("[data-align-en][data-lit]");

test.describe("notes screen ULT alignment strip (#431)", () => {
  test("desktop: hovering either side lights the aligned group on both", async ({ browser }) => {
    const { context, page } = await openNotes(browser, "ult-align-desk", 1280, false, "/#/notes/ZEC/1/1");
    await expect(strip(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /Show which ULT words translate/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // ZEC 1:1 has 16 Hebrew words; nothing lit before a hover.
    await expect(strip(page).locator("[data-align-orig]")).toHaveCount(16);
    await expect(litOrig(page)).toHaveCount(0);
    // The 1:1 notes quote Hebrew, so the #430 quote mark is still painted.
    await expect(strip(page).locator("[data-quoted]").first()).toBeVisible();
    // The English row reads LTR, the Hebrew row RTL.
    expect(await en(page, "Yahweh").evaluate((el) => getComputedStyle(el).direction)).toBe("ltr");
    expect(await orig(page, 7).evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");

    // English → Hebrew: "Yahweh" is one group with "the word of … came",
    // aligned to הָיָה דְבַר יְהוָה (positions 5-7).
    await en(page, "Yahweh").hover();
    await expect(litOrig(page)).toHaveCount(3);
    for (const p of [5, 6, 7]) await expect(orig(page, p)).toHaveAttribute("data-lit", "true");
    await expect(en(page, "word")).toHaveAttribute("data-lit", "true");
    await expect(en(page, "Darius")).not.toHaveAttribute("data-lit", "true");

    // Hebrew → English: בַּחֹדֶשׁ (0) lights "In the eighth month".
    await orig(page, 0).hover();
    await expect(en(page, "month")).toHaveAttribute("data-lit", "true");
    await expect(en(page, "eighth")).toHaveAttribute("data-lit", "true");
    await expect(en(page, "Yahweh")).not.toHaveAttribute("data-lit", "true");
    await expect(orig(page, 1)).toHaveAttribute("data-lit", "true");

    // Moving off clears it.
    await page.mouse.move(2, 2);
    await expect(litOrig(page)).toHaveCount(0);

    // Alignment off → back to #430's plain lane.
    await page.getByRole("button", { name: /Show which ULT words translate/ }).click();
    await expect(strip(page)).toHaveCount(0);
    await context.close();
  });

  test("a supplied English word lights nothing", async ({ browser }) => {
    const { context, page } = await openNotes(browser, "ult-align-sup", 1280, false, "/#/notes/ZEC/1/10");
    await expect(strip(page)).toBeVisible({ timeout: 20_000 });
    const supplied = strip(page).locator('[data-align-en="These"][data-supplied]');
    await expect(supplied).toHaveCount(1);
    await supplied.hover({ force: true });
    await expect(litOrig(page)).toHaveCount(0);
    await expect(litEn(page)).toHaveCount(0);
    await context.close();
  });

  test("phone: tap selects, tap again clears, no sideways scroll", async ({ browser }) => {
    const { context, page } = await openNotes(browser, "ult-align-phone", 390, true, "/#/notes/ZEC/1/1");
    await expect(strip(page)).toBeVisible({ timeout: 20_000 });
    await en(page, "Yahweh").tap();
    await expect(litOrig(page)).toHaveCount(3);
    await expect(en(page, "Yahweh")).toHaveAttribute("aria-pressed", "true");
    await orig(page, 0).tap();
    await expect(en(page, "month")).toHaveAttribute("data-lit", "true");
    await expect(en(page, "Yahweh")).not.toHaveAttribute("data-lit", "true");
    await orig(page, 0).tap();
    await expect(litOrig(page)).toHaveCount(0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await context.close();
  });
});
