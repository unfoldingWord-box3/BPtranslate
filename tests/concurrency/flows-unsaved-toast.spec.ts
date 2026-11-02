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
  const toast = page.getByRole("status").filter({ hasText: ui(EN, "widgets.toasts.unsavedDraftRef", { ref: REF }) });
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

  await toast.getByRole("button", { name: ui(EN, "widgets.toasts.goToDraftAria", { ref: REF }) }).click();
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
  const toast = page.getByRole("status").filter({ hasText: ui(AR, "widgets.toasts.unsavedDraftRef", { ref: REF }) });
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(toast.getByRole("button", { name: ui(AR, "widgets.toasts.goToDraftAria", { ref: REF }) })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("372-toast-ar.png") });
  await page.context().close();
});

// tW/tA articles are edited on Translate Words and note templates on Curate,
// so a draft of either stays quiet there and toasts elsewhere. The seeded
// workspace is an authoring project, where Translate Words shows only a
// notice and has no articles to type into, so the drafts are written through
// the app's own drafts module (the same instance the editors use) while the
// route is open. The on-screen rule is decided by the route alone.
test("#372: article and template drafts stay quiet on their own flows screens", async ({ browser }, testInfo) => {
  const { context } = await newUserContext(browser, "unsaved-toast-372-words");
  openContexts.push(context);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("https://git.door43.org/**", (route) => route.fulfill({ status: 404, body: "not mocked" }));
  const seed = (meta: Record<string, string>, key: string) =>
    page.evaluate(
      async ({ meta, key }) => {
        const url = "/src/sync/drafts.ts";
        const m = await import(/* @vite-ignore */ url);
        await m.drafts.set(key, { target_md: "Unsaved article or template text" }, 1, meta);
      },
      { meta, key },
    );
  const articleRef = "TW kt/god";
  const templateRef = "rc://*/ta/man/translate/figs-idiom · zz-l4-template";
  const articleToast = page.getByRole("status").filter({ hasText: ui(EN, "widgets.toasts.unsavedDraftRef", { ref: articleRef }) });
  const templateToast = page.getByRole("status").filter({ hasText: ui(EN, "widgets.toasts.unsavedDraftRef", { ref: templateRef }) });

  await page.goto("/#/words/ZEC");
  await expect(page.getByRole("toolbar")).toBeVisible({ timeout: 20_000 });
  await seed(
    { kind: "article", resource: "tw", articleId: "kt/god", path: "bible/kt/god.md", part: "body" },
    "article:tw:bible/kt/god.md",
  );
  await expect(page.getByText(`1 ${ui(EN, "sync.unsaved")}`)).toBeVisible({ timeout: 15_000 });
  await expect(articleToast).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("372-words-quiet.png") });

  await page.evaluate(() => (location.hash = "#/admin/curate"));
  await expect(articleToast).toBeVisible({ timeout: 15_000 });
  await seed(
    { kind: "template", templateId: "zz-l4-template", supportRef: "rc://*/ta/man/translate/figs-idiom" },
    "template:zz-l4-template",
  );
  await expect(page.getByText(`2 ${ui(EN, "sync.unsaved")}`)).toBeVisible({ timeout: 15_000 });
  await expect(templateToast).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("372-curate-quiet.png") });

  await page.evaluate(() => (location.hash = "#/books"));
  await expect(templateToast).toBeVisible({ timeout: 15_000 });
  await expect(articleToast).toBeVisible();
  await templateToast.getByRole("button", { name: ui(EN, "widgets.toasts.goToDraftAria", { ref: templateRef }) }).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/admin/curate/zz-l4-template");
  await expect(templateToast).toHaveCount(0);
});
