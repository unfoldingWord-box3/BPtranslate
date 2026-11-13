import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { newUserContext } from "./helpers";

// Issue #909. The desk Style page's Brief, Instructions and Common issues
// editors kept unsaved typing only in React state:
//   (a) a history restore remounts the three editors (a lesson move remounts
//       Common issues), and the typing was lost;
//   (b) after another admin changed Common issues and this page's Brief save
//       brought the new prefs version in, a Common issues save sent this
//       page's stale text at the current version: a 200 that erased the other
//       change.
// Now the editors keep their typing in the drafts store (restored on mount)
// and a save whose field changed on the server since the text was typed is
// sent at the version it was typed against, so the server answers 409.
//
// Uses no scripture chapter: only the singleton translation_prefs row. The
// page shows its memory sections only in a translation project, so the
// project is switched to translation mode for this file and back after.

const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";
const SHOTS = process.env.BE_SHOT_DIR;
const PREFS = "/api/translation-memory/prefs";

const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of openContexts.splice(0)) await c.close().catch(() => {});
});

interface Prefs {
  version: number;
  audience: string | null;
  instructions_md: string | null;
  common_issues_md: string | null;
}

async function adminContext(browser: Browser, name: string) {
  const { context, auth } = await newUserContext(browser, "dev");
  openContexts.push(context);
  void name;
  return { context, csrf: auth.csrf };
}

async function setMode(request: APIRequestContext, csrf: string, mode: "authoring" | "translation") {
  const res = await request.patch("/api/project-config/mode", {
    headers: { "x-csrf-token": csrf, "Content-Type": "application/json" },
    data: { mode },
  });
  expect(res.ok(), `mode ${mode}: ${res.status()} ${await res.text()}`).toBeTruthy();
}

async function getPrefs(request: APIRequestContext): Promise<Prefs> {
  const res = await request.get(PREFS);
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { prefs: Prefs }).prefs;
}

async function putPrefs(request: APIRequestContext, csrf: string, patch: Partial<Prefs>): Promise<Prefs> {
  const cur = await getPrefs(request);
  const res = await request.put(PREFS, {
    headers: { "x-csrf-token": csrf, "If-Match": String(cur.version), "Content-Type": "application/json" },
    data: patch,
  });
  expect(res.ok(), `PUT prefs: ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { prefs: Prefs }).prefs;
}

const briefBox = (p: Page) => p.locator('#style-sec-brief textarea:not([aria-hidden="true"])').first();
const commonBox = (p: Page) => p.locator('#style-sec-commonIssues textarea:not([aria-hidden="true"])').first();
const saveIn = (p: Page, section: string) => p.locator(`#style-sec-${section}`).getByRole("button", { name: "Save" });

async function openStyle(page: Page, expectCommon: string) {
  page.on("dialog", (d) => void d.accept());
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE}/#/admin/style`);
  await expect(commonBox(page)).toHaveValue(expectCommon, { timeout: 20_000 });
}

// Click a section's Save and return the status of the prefs PUT it sends.
async function clickSave(page: Page, section: string): Promise<number> {
  const resp = page.waitForResponse((r) => r.url().includes(PREFS) && r.request().method() === "PUT");
  await saveIn(page, section).click();
  return (await resp).status();
}

// Save Brief. This page's prefs are stale after another admin's save, so the
// first try is the existing 409 that adopts the server row; the second lands.
async function saveBrief(page: Page) {
  const first = await clickSave(page, "brief");
  if (first === 409) expect(await clickSave(page, "brief")).toBe(200);
  else expect(first).toBe(200);
}

let setup: { context: BrowserContext; csrf: string } | null = null;
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE });
  const res = await context.request.post("/api/auth/dev", { data: { username: "dev" } });
  expect(res.ok()).toBeTruthy();
  const csrf = (await context.request.storageState()).cookies.find((c) => c.name === "be_csrf")?.value ?? "";
  setup = { context, csrf };
  await setMode(context.request, csrf, "translation");
});
test.afterAll(async () => {
  if (!setup) return;
  await setMode(setup.context.request, setup.csrf, "authoring").catch(() => {});
  await setup.context.close();
});

test("(a) typing in Brief and Common issues survives a history restore, shown as unsaved, and a reload", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const { request } = setup!.context;
  const v1 = await putPrefs(request, setup!.csrf, {
    audience: `909a audience ${stamp}`,
    common_issues_md: `909a common v1 ${stamp}`,
  });
  // A second save, so there is an earlier version to restore.
  await putPrefs(request, setup!.csrf, { common_issues_md: `909a common v2 ${stamp}` });

  const { context } = await adminContext(browser, "a");
  const page = await context.newPage();
  await openStyle(page, `909a common v2 ${stamp}`);

  await commonBox(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" TYPED-COMMON");
  await briefBox(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" TYPED-BRIEF");

  // Restore version v1 from the history dialog: the editors remount.
  await page.getByRole("button", { name: "History" }).click();
  await page.getByRole("button", { name: `Restore version ${v1.version}` }).click();
  const restored = page.waitForResponse((r) => r.url().includes(PREFS) && r.request().method() === "PUT");
  await page.getByRole("dialog").getByRole("button", { name: "Restore" }).last().click();
  expect((await restored).status()).toBe(200);
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).last().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await expect(commonBox(page)).toHaveValue(`909a common v2 ${stamp} TYPED-COMMON`, { timeout: 10_000 });
  await expect(briefBox(page)).toHaveValue(`909a audience ${stamp} TYPED-BRIEF`);
  await expect(page.getByText("2 unsaved").first()).toBeVisible();
  if (SHOTS) {
    await page.locator("#style-sec-brief").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/style-page-drafts-after-restore-brief.png` });
    await page.locator("#style-sec-commonIssues").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/style-page-drafts-after-restore-common.png` });
  }

  // And a reload brings the typing back too.
  await page.reload();
  await expect(commonBox(page)).toHaveValue(`909a common v2 ${stamp} TYPED-COMMON`, { timeout: 20_000 });
  await expect(briefBox(page)).toHaveValue(`909a audience ${stamp} TYPED-BRIEF`);
});

// The three editors share one prefs version (#145): saving Brief must not make
// this page's own Common issues save conflict, and a landed save clears its
// draft.
test("own saves: Brief then Common issues both land, and the drafts clear", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  await putPrefs(setup!.context.request, setup!.csrf, {
    audience: `909d audience ${stamp}`,
    common_issues_md: `909d common ${stamp}`,
  });
  const { context } = await adminContext(browser, "d");
  const page = await context.newPage();
  await openStyle(page, `909d common ${stamp}`);
  await commonBox(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" OWN-COMMON");
  await briefBox(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" OWN-BRIEF");
  await expect(page.getByText("2 unsaved").first()).toBeVisible({ timeout: 10_000 });

  expect(await clickSave(page, "brief")).toBe(200);
  expect(await clickSave(page, "commonIssues")).toBe(200);
  const prefs = await getPrefs(setup!.context.request);
  expect(prefs.audience).toBe(`909d audience ${stamp} OWN-BRIEF`);
  expect(prefs.common_issues_md).toBe(`909d common ${stamp} OWN-COMMON`);
  await expect(page.getByText(/\d+ unsaved/)).toHaveCount(0, { timeout: 10_000 });

  await page.reload();
  await expect(commonBox(page)).toHaveValue(`909d common ${stamp} OWN-COMMON`, { timeout: 20_000 });
  await expect(page.getByText(/\d+ unsaved/)).toHaveCount(0);
});

// The classic Preferences page has its own editors on the same drafts.
test("(a, classic Preferences) typing in Common issues survives a history restore", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const { request } = setup!.context;
  const v1 = await putPrefs(request, setup!.csrf, { common_issues_md: `909c common v1 ${stamp}` });
  await putPrefs(request, setup!.csrf, { common_issues_md: `909c common v2 ${stamp}` });

  const { context } = await adminContext(browser, "c");
  const page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE}/#/preferences/commonIssues`);
  const box = page.locator('#pref-sec-commonIssues textarea:not([aria-hidden="true"])').first();
  await expect(box).toHaveValue(`909c common v2 ${stamp}`, { timeout: 20_000 });
  await box.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" TYPED-CLASSIC");

  await page.getByRole("button", { name: "History" }).click();
  await page.getByRole("button", { name: `Restore version ${v1.version}` }).click();
  const restored = page.waitForResponse((r) => r.url().includes(PREFS) && r.request().method() === "PUT");
  await page.getByRole("dialog").getByRole("button", { name: "Restore" }).last().click();
  expect((await restored).status()).toBe(200);
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).last().click();

  // (The classic Preferences page has no "N unsaved" chip to check.)
  await expect(box).toHaveValue(`909c common v2 ${stamp} TYPED-CLASSIC`, { timeout: 10_000 });
});

for (const typed of [false, true]) {
  test(`(b) another admin's Common issues change is not erased by a stale save (A ${
    typed ? "typed" : "did not type"
  } in Common issues)`, async ({ browser }) => {
    test.setTimeout(90_000);
    const stamp = Date.now();
    await putPrefs(setup!.context.request, setup!.csrf, {
      audience: `909b audience ${stamp}`,
      common_issues_md: `909b common start ${stamp}`,
    });

    const a = await adminContext(browser, "a");
    const pageA = await a.context.newPage();
    await openStyle(pageA, `909b common start ${stamp}`);
    if (typed) {
      await commonBox(pageA).click();
      await pageA.keyboard.press("End");
      await pageA.keyboard.type(" A-TYPED");
    }

    // B, another browser, changes Common issues.
    const b = await adminContext(browser, "b");
    const bText = `909b common from B ${stamp}`;
    await putPrefs(b.context.request, b.csrf, { common_issues_md: bText });

    // A saves Brief (bringing the new prefs version in), then Common issues.
    await briefBox(pageA).click();
    await pageA.keyboard.press("End");
    await pageA.keyboard.type(" A-BRIEF");
    await saveBrief(pageA);
    expect(await clickSave(pageA, "commonIssues")).toBe(409);
    expect((await getPrefs(setup!.context.request)).common_issues_md).toBe(bText);
    expect((await getPrefs(setup!.context.request)).audience).toBe(`909b audience ${stamp} A-BRIEF`);

    if (typed) {
      // A's typing is kept (the existing "save again to apply" conflict).
      await expect(commonBox(pageA)).toHaveValue(`909b common start ${stamp} A-TYPED`);
    } else {
      // Nothing typed: the box now shows B's text.
      await expect(commonBox(pageA)).toHaveValue(bText);
    }
    if (SHOTS) await pageA.screenshot({ path: `${SHOTS}/style-page-drafts-conflict-${typed ? "typed" : "untyped"}.png` });
  });
}
