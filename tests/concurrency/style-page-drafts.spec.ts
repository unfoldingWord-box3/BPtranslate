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
// Close the page as a user closing the tab would, and say whether it asked
// "leave with unsaved changes?" (the unload guard; review B2).
async function closePrompts(page: Page): Promise<boolean> {
  let prompted = false;
  page.on("dialog", (d) => {
    if (d.type() === "beforeunload") prompted = true;
  });
  const closed = page.waitForEvent("close");
  await page.close({ runBeforeUnload: true });
  await closed;
  return prompted;
}
const scriptNotesBox = (p: Page) => p.locator('#style-sec-brief textarea:not([aria-hidden="true"])').nth(2);
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

// Item 1: tab A restores the draft tab B is still showing. A one-step undo in
// A, or a save of different text there, used to delete that record, so B's
// "1 unsaved" and its unload warning went away while B still showed the text.
// B now keeps its record. (A save of B's exact text makes B clean: review A2.)
for (const how of ["undo", "save"] as const) {
  test(`913 item 1: ${how === "undo" ? "an undo" : "a save of different text"} in another tab that restored this tab's draft leaves the draft stored`, async ({
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
    else {
      await commonBox(pageA).click();
      await pageA.keyboard.press("End");
      await pageA.keyboard.type(" A-MORE");
      expect(await clickSave(pageA, "commonIssues")).toBe(200);
    }
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

// Item 6: Discard from the unsaved menu while the page is still loading the
// prefs row. The draft was already read, so it used to come back once the row
// arrived; now the box shows the server's text and nothing is stored.
test("913 item 6: a discard before the editor finished loading is not restored", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const original = `913-6 common ${stamp}`;
  await putPrefs(setup!.context.request, setup!.csrf, { common_issues_md: original });
  const { context } = await adminContext(browser, "a");
  const page = await context.newPage();
  await openStyle(page, original);
  await commonBox(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" THROWN-AWAY");
  await expect.poll(() => prefsDrafts(page)).toHaveProperty("prefs:common_issues_md");

  // Hold the prefs row on the reload until the discard is done.
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await page.route(`**${PREFS}`, async (route) => {
    if (route.request().method() === "GET") await gate;
    await route.continue();
  });
  await page.reload();
  await page.getByText("1 unsaved").first().click({ timeout: 20_000 });
  await page.getByRole("presentation").getByText("1 unsaved").click();
  await page.getByRole("button", { name: "Discard this edit" }).click();
  await expect.poll(() => prefsDrafts(page)).toEqual({});
  release();

  await expect(commonBox(page)).toHaveValue(original, { timeout: 20_000 });
  await page.waitForTimeout(500);
  await expect(page.getByText(/\d+ unsaved/)).toHaveCount(0);
  expect(await prefsDrafts(page)).toEqual({});
});

// Two tabs showing one prefs draft. "Discard this edit" in one of them throws
// the text away in both: each box goes back to the server's text, and the
// other tab does not write the draft back (review A1).
test("913 A1: a discard in one tab resets the other tab showing the same draft", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const original = `913-a1 common ${stamp}`;
  await putPrefs(setup!.context.request, setup!.csrf, { common_issues_md: original });
  const { context } = await adminContext(browser, "a");
  const pageB = await context.newPage();
  await openStyle(pageB, original);
  await commonBox(pageB).click();
  await pageB.keyboard.press("End");
  await pageB.keyboard.type(" B-TYPED");
  await expect.poll(() => prefsDrafts(pageB)).toHaveProperty("prefs:common_issues_md");
  const pageA = await context.newPage();
  await openStyle(pageA, `${original} B-TYPED`);

  await pageA.getByText("1 unsaved").first().click();
  await pageA.getByRole("presentation").getByText("1 unsaved").click();
  await pageA.getByRole("button", { name: "Discard this edit" }).click();
  await expect(commonBox(pageA)).toHaveValue(original);
  await pageA.waitForTimeout(1000);

  await pageB.bringToFront();
  await expect(commonBox(pageB)).toHaveValue(original);
  expect(await prefsDrafts(pageB)).toEqual({});
  await expect(pageB.getByText(/\d+ unsaved/)).toHaveCount(0);
  await expect(pageA.getByText(/\d+ unsaved/)).toHaveCount(0);
  // Nothing is unsaved in B, so closing it does not ask (review B2).
  expect(await closePrompts(pageB)).toBe(false);
});

// Tab A restores tab B's typing and saves it as it is. B's text is now the
// saved text, so B is clean too: neither tab shows "1 unsaved" (review A2).
test("913 A2: a save of this tab's exact text in another tab leaves both tabs clean", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const original = `913-a2 common ${stamp}`;
  const typedB = `${original} B-TYPED`;
  await putPrefs(setup!.context.request, setup!.csrf, { common_issues_md: original });
  const { context } = await adminContext(browser, "a");
  const pageB = await context.newPage();
  await openStyle(pageB, original);
  await commonBox(pageB).click();
  await pageB.keyboard.press("End");
  await pageB.keyboard.type(" B-TYPED");
  await expect.poll(() => prefsDrafts(pageB)).toHaveProperty("prefs:common_issues_md");
  const pageA = await context.newPage();
  await openStyle(pageA, typedB);
  expect(await clickSave(pageA, "commonIssues")).toBe(200);
  expect((await getPrefs(setup!.context.request)).common_issues_md).toBe(typedB);
  await pageA.waitForTimeout(1000);

  await pageB.bringToFront();
  await expect(commonBox(pageB)).toHaveValue(typedB);
  expect(await prefsDrafts(pageB)).toEqual({});
  await expect(pageB.getByText(/\d+ unsaved/)).toHaveCount(0);
  await expect(pageA.getByText(/\d+ unsaved/)).toHaveCount(0);
  // B's next save of that box goes through: it holds the new version.
  await commonBox(pageB).click();
  await pageB.keyboard.press("End");
  await pageB.keyboard.type(" B-AGAIN");
  expect(await clickSave(pageB, "commonIssues")).toBe(200);
  await expect(pageB.getByText(/\d+ unsaved/)).toHaveCount(0);
  // Nothing is unsaved in B, so closing it does not ask (review B2).
  expect(await closePrompts(pageB)).toBe(false);
});

// Review B2, without B saving again: after adopting A's save of its exact
// text, B closes without the unsaved-changes prompt.
test("913 B2: a tab made clean by another tab's save closes without a prompt", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const original = `913-b2 common ${stamp}`;
  await putPrefs(setup!.context.request, setup!.csrf, { common_issues_md: original });
  const { context } = await adminContext(browser, "a");
  const pageB = await context.newPage();
  await openStyle(pageB, original);
  await commonBox(pageB).click();
  await pageB.keyboard.press("End");
  await pageB.keyboard.type(" B-TYPED");
  await expect.poll(() => prefsDrafts(pageB)).toHaveProperty("prefs:common_issues_md");
  const pageA = await context.newPage();
  await openStyle(pageA, `${original} B-TYPED`);
  expect(await clickSave(pageA, "commonIssues")).toBe(200);
  await pageA.waitForTimeout(1000);
  await expect(pageB.getByText(/\d+ unsaved/)).toHaveCount(0);
  expect(await closePrompts(pageB)).toBe(false);
});

// Review B1: a tab that adopts another tab's save takes that save's whole
// prefs row, not just its version. Its next Brief save keeps every box the
// other tab saved, and a box nobody typed in saves without a false 409.
for (const edit of ["audience", "script notes"] as const) {
  test(`913 B1: after adopting another tab's Brief save, editing ${edit} keeps the other saved box`, async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const stamp = Date.now();
    await putPrefs(setup!.context.request, setup!.csrf, {
      audience: `b1 audience ${stamp}`,
      purpose: `b1 purpose ${stamp}`,
      common_issues_md: `b1 common ${stamp}`,
    });
    const { context } = await adminContext(browser, "a");
    const pageB = await context.newPage();
    await openStyle(pageB, `b1 common ${stamp}`);
    await briefBox(pageB).click();
    await pageB.keyboard.press("End");
    await pageB.keyboard.type(" B1");
    await purposeBox(pageB).click();
    await pageB.keyboard.press("End");
    await pageB.keyboard.type(" B2");
    await expect
      .poll(() => prefsDrafts(pageB))
      .toEqual({
        "prefs:brief": expect.stringContaining(`b1 purpose ${stamp} B2`),
      });

    // A restores both boxes and saves them (T differs from the start in two).
    const pageA = await context.newPage();
    await openStyle(pageA, `b1 common ${stamp}`);
    await expect(briefBox(pageA)).toHaveValue(`b1 audience ${stamp} B1`);
    await expect(purposeBox(pageA)).toHaveValue(`b1 purpose ${stamp} B2`);
    expect(await clickSave(pageA, "brief")).toBe(200);
    await pageA.waitForTimeout(1000);
    await expect(pageB.getByText(/\d+ unsaved/)).toHaveCount(0);

    await pageB.bringToFront();
    const box = edit === "audience" ? briefBox(pageB) : scriptNotesBox(pageB);
    await box.click();
    await pageB.keyboard.press("End");
    await pageB.keyboard.type(" B3");
    expect(await clickSave(pageB, "brief")).toBe(200);
    const p = (await getPrefs(setup!.context.request)) as Prefs & { script_notes: string | null };
    expect(p.purpose).toBe(`b1 purpose ${stamp} B2`);
    if (edit === "audience") expect(p.audience).toBe(`b1 audience ${stamp} B1 B3`);
    else {
      expect(p.audience).toBe(`b1 audience ${stamp} B1`);
      expect(p.script_notes ?? "").toMatch(/B3$/);
    }
  });
}

// Review B3: a discard throws away the discarded text only. Tab B shows Y;
// tab C changes it to X (the stored draft is now X) and discards X. B keeps
// Y, and the store ends holding Y.
test("913 B3: a discard of one tab's text leaves another tab's different typing", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const original = `913-b3 common ${stamp}`;
  const y = `${original} Y`;
  await putPrefs(setup!.context.request, setup!.csrf, { common_issues_md: original });
  const { context } = await adminContext(browser, "a");
  const pageB = await context.newPage();
  await openStyle(pageB, original);
  await commonBox(pageB).click();
  await pageB.keyboard.press("End");
  await pageB.keyboard.type(" Y");
  await expect
    .poll(() => prefsDrafts(pageB))
    .toEqual({ "prefs:common_issues_md": JSON.stringify({ common_issues_md: y }) });
  const pageC = await context.newPage();
  await openStyle(pageC, y);
  await commonBox(pageC).click();
  await pageC.keyboard.press("End");
  await pageC.keyboard.type(" X");
  await expect
    .poll(() => prefsDrafts(pageC))
    .toEqual({ "prefs:common_issues_md": JSON.stringify({ common_issues_md: `${y} X` }) });

  await pageC.getByText("1 unsaved").first().click();
  await pageC.getByRole("presentation").getByText("1 unsaved").click();
  await pageC.getByRole("button", { name: "Discard this edit" }).click();
  await expect(commonBox(pageC)).toHaveValue(original);
  await pageC.waitForTimeout(1000);

  await pageB.bringToFront();
  await expect(commonBox(pageB)).toHaveValue(y);
  await expect
    .poll(() => prefsDrafts(pageB), { timeout: 5_000 })
    .toEqual({ "prefs:common_issues_md": JSON.stringify({ common_issues_md: y }) });
});

// Review B4: the item 1 rewrite never replaces a record another tab wrote in
// the meantime: it writes only when the key is absent, in one transaction.
test("913 B4: the drafts store's set-if-absent leaves an existing record", async ({ browser }) => {
  test.setTimeout(60_000);
  const { context } = await adminContext(browser, "a");
  const page = await context.newPage();
  await openStyle(page, (await getPrefs(setup!.context.request)).common_issues_md ?? "");
  const out = await page.evaluate(async () => {
    const url = "/src/sync/drafts.ts";
    const m = await import(/* @vite-ignore */ url);
    const key = "prefs:913-b4-probe";
    const meta = { kind: "prefs", section: "common_issues_md" };
    await m.drafts.clear(key);
    const first = await m.drafts.setIfAbsent(key, { text: { v: "first" }, base: { v: "" } }, 1, meta);
    const second = await m.drafts.setIfAbsent(key, { text: { v: "second" }, base: { v: "" } }, 1, meta);
    const rec = await m.drafts.get(key);
    await m.drafts.clear(key);
    return { first, second, text: rec?.payload?.text?.v };
  });
  expect(out).toEqual({ first: true, second: false, text: "first" });
});

// Review round 3, C1: tab A saves Brief while tab B is still loading, and B's
// prefs GET (read before A's save) lands after A's broadcast. B keeps the
// newer row: a later save of a box nobody typed in lands first time, and
// A's saved text stays.
test("913 C1: a stale first load does not replace another tab's newer saved row", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  await putPrefs(setup!.context.request, setup!.csrf, {
    audience: `c1 audience ${stamp}`,
    common_issues_md: `c1 common ${stamp}`,
  });
  const { context } = await adminContext(browser, "a");
  const pageA = await context.newPage();
  await openStyle(pageA, `c1 common ${stamp}`);
  await briefBox(pageA).click();
  await pageA.keyboard.press("End");
  await pageA.keyboard.type(" A");

  // B reads the row now, but gets it only after A's save.
  const pageB = await context.newPage();
  pageB.on("dialog", (d) => void d.accept());
  await pageB.setViewportSize({ width: 1280, height: 900 });
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await pageB.route(`**${PREFS}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    await gate;
    await route.fulfill({ response: res });
  });
  const asked = pageB.waitForRequest((r) => r.url().includes(PREFS) && r.method() === "GET");
  await pageB.goto(`${BASE}/#/admin/style`);
  await asked;
  await pageB.waitForTimeout(500);

  await pageA.bringToFront();
  expect(await clickSave(pageA, "brief")).toBe(200);
  await pageA.waitForTimeout(500);
  release();

  await pageB.bringToFront();
  await expect(commonBox(pageB)).toHaveValue(`c1 common ${stamp}`, { timeout: 20_000 });
  await expect(briefBox(pageB)).toHaveValue(`c1 audience ${stamp} A`);
  await scriptNotesBox(pageB).click();
  await pageB.keyboard.press("End");
  await pageB.keyboard.type(" C1");
  expect(await clickSave(pageB, "brief")).toBe(200);
  const p = await getPrefs(setup!.context.request);
  expect(p.audience).toBe(`c1 audience ${stamp} A`);
});

// Review round 3, D1: tab A's own save response arrives late, after tab B
// saved a newer row that A already took from B's broadcast. A settles on
// the newest row it knows, not its own older response: it shows B's Purpose
// with nothing unsaved, and its next save of a box nobody typed in lands.
test("913 D1: a late save response does not move the editor back to an older row", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  await putPrefs(setup!.context.request, setup!.csrf, {
    audience: `d1 audience ${stamp}`,
    purpose: `d1 purpose ${stamp}`,
    common_issues_md: `d1 common ${stamp}`,
  });
  const { context } = await adminContext(browser, "a");
  const pageA = await context.newPage();
  await openStyle(pageA, `d1 common ${stamp}`);
  const pageB = await context.newPage();
  await openStyle(pageB, `d1 common ${stamp}`);

  // A's save reaches the server now; its response is held.
  await pageA.bringToFront();
  await briefBox(pageA).click();
  await pageA.keyboard.press("End");
  await pageA.keyboard.type(" A");
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await pageA.route(`**${PREFS}`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const res = await route.fetch();
    await gate;
    await route.fulfill({ response: res });
  });
  const answered = pageA.waitForResponse((r) => r.url().includes(PREFS) && r.request().method() === "PUT");
  await saveIn(pageA, "brief").click();
  await expect.poll(async () => (await getPrefs(setup!.context.request)).audience).toBe(`d1 audience ${stamp} A`);

  // B saves Purpose on top (a 409 first: B's row is older), and broadcasts.
  await pageB.bringToFront();
  await purposeBox(pageB).click();
  await pageB.keyboard.press("End");
  await pageB.keyboard.type(" B");
  await saveBrief(pageB);
  await pageA.waitForTimeout(1000);

  release();
  expect((await answered).status()).toBe(200);
  await pageA.bringToFront();
  await pageA.waitForTimeout(500);
  await expect(purposeBox(pageA)).toHaveValue(`d1 purpose ${stamp} B`);
  await expect(briefBox(pageA)).toHaveValue(`d1 audience ${stamp} A`);
  await expect(pageA.getByText(/\d+ unsaved/)).toHaveCount(0);

  await pageA.unroute(`**${PREFS}`);
  await scriptNotesBox(pageA).click();
  await pageA.keyboard.press("End");
  await pageA.keyboard.type(" D1");
  expect(await clickSave(pageA, "brief")).toBe(200);
  const p = await getPrefs(setup!.context.request);
  expect(p.purpose).toBe(`d1 purpose ${stamp} B`);
  expect(p.audience).toBe(`d1 audience ${stamp} A`);
});

// ── Issue #922: leftovers from the #913 review ──────────────────────────────

// Item 1: a write-back that has started (another tab's "drafts changed"
// message got here before its discard message) checks, inside its
// transaction, that this tab still shows the typing. A discard handled in the
// meantime has reset the box, so the thrown-away text is not stored again.
test("922 item 1: set-if-absent skips the write when the editor no longer shows the typing", async ({ browser }) => {
  test.setTimeout(60_000);
  const { context } = await adminContext(browser, "a");
  const page = await context.newPage();
  await openStyle(page, (await getPrefs(setup!.context.request)).common_issues_md ?? "");
  const out = await page.evaluate(async () => {
    const url = "/src/sync/drafts.ts";
    const m = await import(/* @vite-ignore */ url);
    const key = "prefs:922-item1-probe";
    const meta = { kind: "prefs", section: "common_issues_md" };
    await m.drafts.clear(key);
    const wrote = await m.drafts.setIfAbsent(key, { text: { v: "discarded" }, base: { v: "" } }, 1, meta, () => false);
    const rec = await m.drafts.get(key);
    const pending = m.hasUnsavedDrafts();
    await m.drafts.clear(key);
    return { wrote, stored: !!rec, pending };
  });
  expect(out).toEqual({ wrote: false, stored: false, pending: false });
});

// Item 2: an admin database restore can lower the prefs version below the one
// this page holds. The 409's row is the server's truth: the page takes it, so
// the next Save lands instead of conflicting until a reload.
test("922 item 2: after the settings version goes down, the second Save lands", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const original = `922-2 common ${stamp}`;
  await putPrefs(setup!.context.request, setup!.csrf, { common_issues_md: original });
  const { context } = await adminContext(browser, "a");
  const page = await context.newPage();
  // The page loads the row at a version 1000 higher than the server's, as if
  // the database was restored to an older copy after the page loaded.
  await page.route(`**${PREFS}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = (await res.json()) as { prefs: Prefs };
    body.prefs.version += 1000;
    await route.fulfill({ response: res, json: body });
  });
  await openStyle(page, original);
  await commonBox(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" DOWN");
  expect(await clickSave(page, "commonIssues")).toBe(409);
  expect(await clickSave(page, "commonIssues")).toBe(200);
  expect((await getPrefs(setup!.context.request)).common_issues_md).toBe(`${original} DOWN`);
});

// Item 3: tab B typed on the Style page and moved to another page, so no
// editor there holds the typing. Tab A then saves or discards that draft. B
// keeps nothing unsaved, so closing it does not ask.
for (const how of ["save", "discard"] as const) {
  test(`922 item 3: after B left the Style page, a ${how} in A leaves B without a leave-page prompt`, async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const stamp = Date.now();
    const original = `922-3${how} common ${stamp}`;
    await putPrefs(setup!.context.request, setup!.csrf, { common_issues_md: original });
    const { context } = await adminContext(browser, "a");
    const pageB = await context.newPage();
    await openStyle(pageB, original);
    await commonBox(pageB).click();
    await pageB.keyboard.press("End");
    await pageB.keyboard.type(" B-TYPED");
    await expect.poll(() => prefsDrafts(pageB)).toHaveProperty("prefs:common_issues_md");
    await pageB.goto(`${BASE}/#/admin/curate`);
    await expect(commonBox(pageB)).toHaveCount(0);
    await pageB.waitForTimeout(500);

    const pageA = await context.newPage();
    await openStyle(pageA, `${original} B-TYPED`);
    if (how === "save") {
      expect(await clickSave(pageA, "commonIssues")).toBe(200);
    } else {
      await pageA.getByText("1 unsaved").first().click();
      await pageA.getByRole("presentation").getByText("1 unsaved").click();
      await pageA.getByRole("button", { name: "Discard this edit" }).click();
      await expect(commonBox(pageA)).toHaveValue(original);
    }
    await expect.poll(() => prefsDrafts(pageA)).toEqual({});
    await pageB.waitForTimeout(1000);
    expect(await closePrompts(pageB)).toBe(false);
  });
}

// Item 4: when classic Preferences cannot read the drafts store, "Move to
// Common issues" is refused with a message that says the check failed, not
// that Common issues has unsaved changes.
test("922 item 4: a failed drafts read refuses the move with its own message", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context } = await adminContext(browser, "a");
  const page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.setViewportSize({ width: 1280, height: 900 });
  const now = Math.floor(Date.now() / 1000);
  await page.route("**/api/translation-memory/lessons", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            enabled: true,
            notMigrated: false,
            availability: { available: true, provider: "gemini", model: "m" },
            lessons: [{ lesson: "922 lesson", before: "a", after: "b", evidence: 2, firstSeenAt: now, pinned: false }],
            setId: 1,
            setAt: now,
            lastRun: null,
            sets: [{ id: 1, at: now, kind: "night", action: null, count: 1 }],
            maxLessons: 20,
          },
        })
      : route.continue(),
  );
  let edits = 0;
  await page.route("**/api/translation-memory/lessons/edit", (route) => {
    edits++;
    return route.abort();
  });
  await page.goto(`${BASE}/#/preferences/lessons`);
  const move = page.getByRole("button", { name: "Move to Common issues" });
  await expect(move).toBeEnabled({ timeout: 20_000 });
  await page.evaluate(async () => {
    const url = "/src/sync/drafts.ts";
    const m = await import(/* @vite-ignore */ url);
    m.drafts.get = () => Promise.reject(new Error("922 item 4: store unreadable"));
  });
  await move.click();
  await expect(page.getByText(/Could not check Common issues for unsaved changes/)).toBeVisible();
  await expect(page.getByText(/Common issues has unsaved changes/)).toHaveCount(0);
  expect(edits).toBe(0);
});
