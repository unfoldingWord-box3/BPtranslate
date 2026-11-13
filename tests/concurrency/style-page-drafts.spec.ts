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
  purpose: string | null;
  notes: string | null;
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
const purposeBox = (p: Page) => p.locator('#style-sec-brief textarea:not([aria-hidden="true"])').nth(1);

// The text of every prefs draft in this page's drafts store, by key.
async function prefsDrafts(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const out: Record<string, string> = {};
    for (const info of await indexedDB.databases()) {
      if (!info.name?.startsWith("bible-editor-drafts")) continue;
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open(info.name!);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      if (db.objectStoreNames.contains("drafts")) {
        const all = await new Promise<Array<{ key: string; payload: { text?: unknown } }>>((res, rej) => {
          const r = db.transaction("drafts").objectStore("drafts").getAll();
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        for (const rec of all) if (rec.key.startsWith("prefs:")) out[rec.key] = JSON.stringify(rec.payload.text);
      }
      db.close();
    }
    return out;
  });
}
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

// ── Gate review fixes ───────────────────────────────────────────────────────

// H1: Brief is judged box by box. A types only in Audience; another admin
// changes Purpose and notes. A's stale save gets the 409, Purpose then shows
// their text, and "save again" keeps their Purpose and notes.
test("H1: typing in one Brief box does not bring back another box's stale text", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  await putPrefs(setup!.context.request, setup!.csrf, {
    audience: `h1 audience ${stamp}`,
    purpose: `h1 purpose ${stamp}`,
    notes: `h1 notes ${stamp}`,
    common_issues_md: `h1 common ${stamp}`,
  });
  const a = await adminContext(browser, "a");
  const page = await a.context.newPage();
  await openStyle(page, `h1 common ${stamp}`);
  await briefBox(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" A-TYPED");

  const b = await adminContext(browser, "b");
  await putPrefs(b.context.request, b.csrf, { purpose: `h1 purpose from B ${stamp}`, notes: `h1 notes from B ${stamp}` });

  expect(await clickSave(page, "brief")).toBe(409);
  await expect(purposeBox(page)).toHaveValue(`h1 purpose from B ${stamp}`);
  await expect(briefBox(page)).toHaveValue(`h1 audience ${stamp} A-TYPED`);
  expect(await clickSave(page, "brief")).toBe(200);
  const p = await getPrefs(setup!.context.request);
  expect(p.audience).toBe(`h1 audience ${stamp} A-TYPED`);
  expect(p.purpose).toBe(`h1 purpose from B ${stamp}`);
  expect(p.notes).toBe(`h1 notes from B ${stamp}`);
});

// H1, remount: the stored Brief draft brings back only the typed box.
test("H1: after a reload, only the typed Brief box comes back from the draft", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  await putPrefs(setup!.context.request, setup!.csrf, {
    audience: `h1r audience ${stamp}`,
    purpose: `h1r purpose ${stamp}`,
    common_issues_md: `h1r common ${stamp}`,
  });
  const a = await adminContext(browser, "a");
  const page = await a.context.newPage();
  await openStyle(page, `h1r common ${stamp}`);
  await briefBox(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" A-TYPED");
  await expect.poll(() => prefsDrafts(page)).toHaveProperty("prefs:brief");

  await putPrefs(setup!.context.request, setup!.csrf, { purpose: `h1r purpose from B ${stamp}` });
  await page.reload();
  await expect(briefBox(page)).toHaveValue(`h1r audience ${stamp} A-TYPED`, { timeout: 20_000 });
  await expect(purposeBox(page)).toHaveValue(`h1r purpose from B ${stamp}`);
  // Audience did not change on the server: the save lands first time.
  expect(await clickSave(page, "brief")).toBe(200);
  expect((await getPrefs(setup!.context.request)).purpose).toBe(`h1r purpose from B ${stamp}`);
  // Round 2 J1 (a): the restored draft is cleared by the save.
  await expect.poll(() => prefsDrafts(page)).toEqual({});
  await expect(page.getByText(/\d+ unsaved/)).toHaveCount(0);
});

// Round 2 J1 (b): after a remount brings a draft back, undoing the typing in
// one step clears the stored draft, so the next mount does not bring it back.
test("J1: undoing a restored draft in one step clears it", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const original = `j1 common ${stamp}`;
  await putPrefs(setup!.context.request, setup!.csrf, { common_issues_md: original });
  const { context } = await adminContext(browser, "a");
  const page = await context.newPage();
  await openStyle(page, original);
  await commonBox(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" TYPED");
  await expect.poll(() => prefsDrafts(page)).toHaveProperty("prefs:common_issues_md");
  await page.reload();
  await expect(commonBox(page)).toHaveValue(`${original} TYPED`, { timeout: 20_000 });
  await commonBox(page).fill(original);
  await expect.poll(() => prefsDrafts(page)).toEqual({});
  await page.reload();
  await expect(commonBox(page)).toHaveValue(original, { timeout: 20_000 });
  await expect(page.getByText(/\d+ unsaved/)).toHaveCount(0);
});

// Round 2 J2: the box is put back while its save is in flight. The undo stays
// in the box as unsaved typing against the saved text.
test("J2: an undo made while a save is in flight is kept", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const original = `j2 common ${stamp}`;
  await putPrefs(setup!.context.request, setup!.csrf, { common_issues_md: original });
  const { context } = await adminContext(browser, "a");
  const page = await context.newPage();
  await openStyle(page, original);
  await commonBox(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" A1");
  await page.route(`**${PREFS}`, async (route) => {
    if (route.request().method() === "PUT") await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  const resp = page.waitForResponse((r) => r.url().includes(PREFS) && r.request().method() === "PUT");
  await saveIn(page, "commonIssues").click();
  await commonBox(page).fill(original);
  expect((await resp).status()).toBe(200);
  expect((await getPrefs(setup!.context.request)).common_issues_md).toBe(`${original} A1`);
  await page.waitForTimeout(300);
  await expect(commonBox(page)).toHaveValue(original);
  await expect(page.getByText("1 unsaved").first()).toBeVisible();
});

// H2: a user whose save would be refused keeps no prefs draft, and one left
// from before is dropped when the editor opens. The page is told the user is
// an editor; the server still accepts this dev user, which this test does not
// rely on.
test("H2: a non-admin on classic Preferences keeps no prefs drafts", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  await putPrefs(setup!.context.request, setup!.csrf, { common_issues_md: `h2 common ${stamp}` });
  const a = await adminContext(browser, "a");
  const page = await a.context.newPage();
  page.on("dialog", (d) => void d.accept());
  const box = page.locator('#pref-sec-commonIssues textarea:not([aria-hidden="true"])').first();

  // As an admin, a draft is kept.
  await page.goto(`${BASE}/#/preferences/commonIssues`);
  await expect(box).toHaveValue(`h2 common ${stamp}`, { timeout: 20_000 });
  await box.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" ADMIN-TYPED");
  await expect.poll(() => prefsDrafts(page)).toHaveProperty("prefs:common_issues_md");

  // Now the app sees an editor: the old draft is dropped, typing keeps none.
  const asEditor = async (route: import("@playwright/test").Route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ response: res, json: { ...body, role: "editor" } });
  };
  await page.route("**/api/auth/me", asEditor);
  await page.route("**/api/auth/dev", asEditor);
  await page.reload();
  await expect(box).toHaveValue(`h2 common ${stamp}`, { timeout: 20_000 });
  await expect.poll(() => prefsDrafts(page)).toEqual({});
  await box.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" EDITOR-TYPED");
  await page.waitForTimeout(500);
  expect(await prefsDrafts(page)).toEqual({});
});

// H3: a 409 whose body carries no `current` row: the editor fetches the row
// and rebases, so the next Save lands instead of 409ing for ever.
test("H3: a 409 without a current row still lets the next Save land", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  await putPrefs(setup!.context.request, setup!.csrf, { common_issues_md: `h3 common ${stamp}` });
  const a = await adminContext(browser, "a");
  const page = await a.context.newPage();
  await openStyle(page, `h3 common ${stamp}`);
  await commonBox(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" A-TYPED");
  await putPrefs(setup!.context.request, setup!.csrf, { common_issues_md: `h3 common from B ${stamp}` });

  let bare = true;
  await page.route(`**${PREFS}`, async (route) => {
    if (route.request().method() === "PUT" && bare) {
      bare = false;
      await route.fulfill({ status: 409, json: { error: "version_mismatch" } });
    } else await route.continue();
  });
  expect(await clickSave(page, "commonIssues")).toBe(409);
  // Save again applies the typed text (the existing conflict handling).
  expect(await clickSave(page, "commonIssues")).toBe(200);
  expect((await getPrefs(setup!.context.request)).common_issues_md).toBe(`h3 common ${stamp} A-TYPED`);
});

// H5: two tabs of one browser share the drafts store. Tab B's newer Common
// issues typing survives tab A saving its own.
test("H5: one tab's save does not clear another tab's newer draft", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  await putPrefs(setup!.context.request, setup!.csrf, { common_issues_md: `h5 common ${stamp}` });
  const { context } = await adminContext(browser, "a");
  const pageA = await context.newPage();
  await openStyle(pageA, `h5 common ${stamp}`);
  const pageB = await context.newPage();
  await openStyle(pageB, `h5 common ${stamp}`);

  await pageA.bringToFront();
  await commonBox(pageA).click();
  await pageA.keyboard.press("End");
  await pageA.keyboard.type(" A");
  await pageB.bringToFront();
  await commonBox(pageB).click();
  await pageB.keyboard.press("End");
  await pageB.keyboard.type(" B-NEWER");
  await expect
    .poll(() => prefsDrafts(pageA))
    .toEqual({ "prefs:common_issues_md": JSON.stringify({ common_issues_md: `h5 common ${stamp} B-NEWER` }) });

  await pageA.bringToFront();
  expect(await clickSave(pageA, "commonIssues")).toBe(200);
  await pageA.waitForTimeout(500);
  expect(await prefsDrafts(pageA)).toEqual({
    "prefs:common_issues_md": JSON.stringify({ common_issues_md: `h5 common ${stamp} B-NEWER` }),
  });
});

// H7: Discard from the unsaved menu while the editor is open puts the
// server's text back in the box.
test("H7: discarding the draft from the unsaved menu resets the open editor", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  await putPrefs(setup!.context.request, setup!.csrf, { common_issues_md: `h7 common ${stamp}` });
  const { context } = await adminContext(browser, "a");
  const page = await context.newPage();
  await openStyle(page, `h7 common ${stamp}`);
  await commonBox(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" THROWN-AWAY");
  await page.getByText("1 unsaved").first().click();
  await page.getByRole("presentation").getByText("1 unsaved").click();
  await page.getByRole("button", { name: "Discard this edit" }).click();
  await expect(commonBox(page)).toHaveValue(`h7 common ${stamp}`);
  await expect(page.getByText(/\d+ unsaved/)).toHaveCount(0);
});

// ── Issue #913: edge cases left by #909 ─────────────────────────────────────

// Item 1: tab A restores the draft tab B is still showing. A one-step undo or
// a save in A used to delete that record, so B's "1 unsaved" and its unload
// warning went away while B still showed the text. B now keeps its record.
for (const how of ["undo", "save"] as const) {
  test(`913 item 1: a ${how} in another tab that restored this tab's draft leaves the draft stored`, async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const stamp = Date.now();
    const original = `913-1${how} common ${stamp}`;
    const typedB = `${original} B-TYPED`;
    await putPrefs(setup!.context.request, setup!.csrf, { common_issues_md: original });
    const { context } = await adminContext(browser, "a");
    const pageB = await context.newPage();
    await openStyle(pageB, original);
    await commonBox(pageB).click();
    await pageB.keyboard.press("End");
    await pageB.keyboard.type(" B-TYPED");
    await expect
      .poll(() => prefsDrafts(pageB))
      .toEqual({ "prefs:common_issues_md": JSON.stringify({ common_issues_md: typedB }) });

    // Tab A opens the page and restores B's typing.
    const pageA = await context.newPage();
    await openStyle(pageA, typedB);
    if (how === "undo") await commonBox(pageA).fill(original);
    else expect(await clickSave(pageA, "commonIssues")).toBe(200);
    await pageA.waitForTimeout(1000);

    // B still shows its typing, so its draft is still stored and counted.
    await pageB.bringToFront();
    await expect(commonBox(pageB)).toHaveValue(typedB);
    await expect
      .poll(() => prefsDrafts(pageB), { timeout: 5_000 })
      .toEqual({ "prefs:common_issues_md": JSON.stringify({ common_issues_md: typedB }) });
    await expect(pageB.getByText("1 unsaved").first()).toBeVisible();
  });
}

// Item 2: Discard from the unsaved menu while the save of that typing is in
// flight. The save lands, so the box shows the saved text with nothing
// unsaved, instead of the discarded-to text coming back as "1 unsaved".
test("913 item 2: a discard while the save is in flight settles on the saved text", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const original = `913-2 common ${stamp}`;
  await putPrefs(setup!.context.request, setup!.csrf, { common_issues_md: original });
  const { context } = await adminContext(browser, "a");
  const page = await context.newPage();
  await openStyle(page, original);
  await commonBox(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" A1");
  await expect.poll(() => prefsDrafts(page)).toHaveProperty("prefs:common_issues_md");

  // Hold the PUT until the discard is done.
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await page.route(`**${PREFS}`, async (route) => {
    if (route.request().method() === "PUT") await gate;
    await route.continue();
  });
  const resp = page.waitForResponse((r) => r.url().includes(PREFS) && r.request().method() === "PUT");
  await saveIn(page, "commonIssues").click();
  await page.getByText("1 unsaved").first().click();
  await page.getByRole("presentation").getByText("1 unsaved").click();
  await page.getByRole("button", { name: "Discard this edit" }).click();
  await expect(commonBox(page)).toHaveValue(original);
  release();
  expect((await resp).status()).toBe(200);
  expect((await getPrefs(setup!.context.request)).common_issues_md).toBe(`${original} A1`);

  await expect(commonBox(page)).toHaveValue(`${original} A1`);
  await page.waitForTimeout(500);
  await expect(page.getByText(/\d+ unsaved/)).toHaveCount(0);
  expect(await prefsDrafts(page)).toEqual({});
});

// Item 5: drafts are per workspace, not per user. On a shared browser, another
// user who cannot save opens classic Preferences: the admin's stored draft is
// left alone (H2 still drops a draft the same user typed before losing admin).
test("913 item 5: a user who cannot save does not delete another user's prefs draft", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  await putPrefs(setup!.context.request, setup!.csrf, { common_issues_md: `913-5 common ${stamp}` });
  const a = await adminContext(browser, "a");
  const page = await a.context.newPage();
  page.on("dialog", (d) => void d.accept());
  const box = page.locator('#pref-sec-commonIssues textarea:not([aria-hidden="true"])').first();
  await page.goto(`${BASE}/#/preferences/commonIssues`);
  await expect(box).toHaveValue(`913-5 common ${stamp}`, { timeout: 20_000 });
  await box.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" ADMIN-TYPED");
  const adminDraft = { "prefs:common_issues_md": JSON.stringify({ common_issues_md: `913-5 common ${stamp} ADMIN-TYPED` }) };
  await expect.poll(() => prefsDrafts(page)).toEqual(adminDraft);

  // Another user, an editor, on the same browser.
  const asOtherEditor = async (route: import("@playwright/test").Route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({
      response: res,
      json: { ...body, role: "editor", userId: Number(body.userId) + 100_000, username: "913-other-editor" },
    });
  };
  await page.route("**/api/auth/me", asOtherEditor);
  await page.route("**/api/auth/dev", asOtherEditor);
  await page.reload();
  await expect(box).toHaveValue(`913-5 common ${stamp}`, { timeout: 20_000 });
  await page.waitForTimeout(1000);
  expect(await prefsDrafts(page)).toEqual(adminDraft);
});
