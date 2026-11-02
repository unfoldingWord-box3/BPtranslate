import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { newUserContext } from "./helpers";

// Flows unsaved-drafts toast (#372, option A). Typing in a flows note editor
// without saving leaves a draft in IndexedDB; on any other flows screen a
// corner toast names it and offers "Go to it", which opens the editor holding
// the draft. On the screen that holds the draft the toast stays quiet.
// Nothing here saves, so the shared ZEC fixture on the server is untouched.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
type Dict = Record<string, unknown>;
const load = (lang: string) =>
  JSON.parse(readFileSync(resolve(repoRoot, `web/src/i18n/locales/${lang}.json`), "utf8")) as Dict;
const EN = load("en");
const AR = load("ar");
function ui(dict: Dict, key: string, vars: Record<string, string> = {}): string {
  const v = key.split(".").reduce<unknown>((o, k) => (o as Dict)?.[k], dict);
  if (typeof v !== "string") throw new Error(`no UI string at ${key}`);
  return v.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
}

const BOOK = "ZEC";
const CHAPTER = 6;
const VERSE = 11;
const ROW = "f66i";
const REF = `TN ${BOOK} ${CHAPTER}:${VERSE}`;
const DRAFT = "Unsaved draft for the flows toast check";

test.describe.configure({ timeout: 120_000 });

// Close every context in afterEach: a failing test never reaches its own
// close, and a page left on ZEC 6 would stay in the chapter room through the
// save-race specs that run next (same reason as rtl-direction.spec.ts).
const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of openContexts.splice(0)) await c.close().catch(() => {});
});

async function openWithDraft(browser: Browser, user: string, uiLang?: string): Promise<Page> {
  const { context } = await newUserContext(browser, user);
  openContexts.push(context);
  if (uiLang) {
    await context.addInitScript((lang) => {
      try {
        localStorage.setItem("be:uiLang", lang);
      } catch {
        /* private mode */
      }
    }, uiLang);
  }
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("https://git.door43.org/**", (route) => route.fulfill({ status: 404, body: "not mocked" }));
  await page.goto(`/#/notes/${BOOK}/${CHAPTER}/${VERSE}?row=${ROW}`);
  // The selected note's draft box: click it to edit, then type without saving.
  const box = page.locator('[role="button"][dir="auto"]').filter({ hasText: "AVD" }).first();
  await box.waitFor({ state: "visible", timeout: 20_000 });
  await box.click();
  const editor = page.locator('textarea:not([aria-hidden="true"])').first();
  await editor.fill(DRAFT);
  return page;
}

test("#372: an unsaved flows note shows a toast elsewhere, and Go to it opens it", async ({ browser }, testInfo) => {
  const page = await openWithDraft(browser, "unsaved-toast-372");
  const toast = page.getByRole("alert").filter({ hasText: ui(EN, "widgets.toasts.unsavedDraftRef", { ref: REF }) });
  // On the screen that holds the draft: no toast, once the toolbar's
  // "1 unsaved" chip shows the draft has landed in the store.
  await expect(page.getByText(`1 ${ui(EN, "sync.unsaved")}`)).toBeVisible({ timeout: 15_000 });
  await expect(toast).toHaveCount(0);

  await page.evaluate(() => (location.hash = "#/books"));
  await expect(page.getByRole("heading", { name: ui(EN, "flowBooks.title"), exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("372-toast.png") });

  await toast.getByRole("button", { name: ui(EN, "widgets.toasts.goToDraft") }).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(
    `#/notes/${BOOK}/${CHAPTER}/${VERSE}?row=${ROW}`,
  );
  // The note's editor restores the draft from IndexedDB, shown as text or in a
  // textarea depending on whether the card reopens in edit mode.
  await expect
    .poll(
      () =>
        page.evaluate(
          (draft) =>
            document.body.innerText.includes(draft) ||
            Array.from(document.querySelectorAll("textarea")).some((t) => t.value === draft),
          DRAFT,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect(toast).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("372-landed.png") });
  await page.context().close();
});

test("#372: the toast under the Arabic UI", async ({ browser }, testInfo) => {
  const page = await openWithDraft(browser, "unsaved-toast-372-ar", "ar");
  await expect(page.getByText(`1 ${ui(AR, "sync.unsaved")}`)).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => (location.hash = "#/books"));
  await expect(page.getByRole("heading", { name: ui(AR, "flowBooks.title"), exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  const toast = page.getByRole("alert").filter({ hasText: ui(AR, "widgets.toasts.unsavedDraftRef", { ref: REF }) });
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(toast.getByRole("button", { name: ui(AR, "widgets.toasts.goToDraft") })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("372-toast-ar.png") });
  await page.context().close();
});
