import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, request as apiRequest, type BrowserContext, type Page } from "@playwright/test";
import { fetchChapter, gotoVerse, mintToken, newUserContext } from "./helpers";

// Issue #896. The drafts store (IndexedDB) is shared by every tab of a
// workspace, but a tab's "N unsaved" chip re-counted only after a change made
// in that same tab. When tab A typed, saved or discarded a draft, tab B kept
// its old count until a reload. Now drafts.ts announces each committed change
// on a BroadcastChannel (draftsChangedChannel.ts) and tab B re-reads the store.
//
// Both pages live in ONE browser context: tabs share IndexedDB and
// BroadcastChannel only within a context. Tab B stays on another verse so no
// editor there holds the draft. Nothing is saved, so the server fixture is
// untouched; ZEC 2 is used because no other spec opens it.

const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";
const SHOTS = process.env.BE_SHOT_DIR;
const CHAPTER = 2;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EN = JSON.parse(readFileSync(resolve(repoRoot, "web/src/i18n/locales/en.json"), "utf8")) as {
  sync: { unsaved: string; discardThisEdit: string };
};
const ONE_UNSAVED = `1 ${EN.sync.unsaved}`;

interface TqRow {
  id: string;
  verse: number;
}

const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of openContexts.splice(0)) await c.close().catch(() => {});
});

async function pickRow(): Promise<TqRow> {
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const auth = await mintToken(probe, "probe-896");
  const chapter = await fetchChapter(probe, auth.token, "ZEC", CHAPTER);
  await probe.dispose();
  // gotoVerse waits for a tN card, so the question's verse must have notes too.
  const noteVerses = new Set((chapter.tn as Array<{ verse: number }>).map((n) => n.verse));
  const rows = (chapter.tq as TqRow[]).filter((r) => r.verse > 1 && noteVerses.has(r.verse));
  expect(rows.length, `expected a tQ row after verse 1 on ZEC ${CHAPTER} on a verse with notes`).toBeGreaterThan(0);
  return rows[0];
}

// Count every "drafts changed" message tab `page` hears from now on, on the
// channel the app names for this workspace (workspaceDbName's rule).
async function countDraftMessages(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    let slug = "default";
    try {
      slug = localStorage.getItem("bible-editor.workspace") || "default";
    } catch {
      /* private mode */
    }
    const name = slug === "default" ? "be-drafts-changed" : `be-drafts-changed-${slug}`;
    const w = window as unknown as { __draftMsgs: number };
    w.__draftMsgs = 0;
    new BroadcastChannel(name).onmessage = () => {
      w.__draftMsgs++;
    };
  });
  return () => page.evaluate(() => (window as unknown as { __draftMsgs: number }).__draftMsgs);
}

test("tab A types then discards a draft: tab B's unsaved count follows without a reload", async ({ browser }) => {
  test.setTimeout(90_000);
  const tq = await pickRow();
  const { context } = await newUserContext(browser, "cross-tab-drafts-896");
  openContexts.push(context);

  // Tab B first, on verse 1 (no editor there holds tab A's row), with nothing unsaved.
  const b = await context.newPage();
  await b.setViewportSize({ width: 1280, height: 900 });
  await gotoVerse(b, "ZEC", CHAPTER, 1);
  await expect(b.getByText(ONE_UNSAVED)).toHaveCount(0);
  const heard = await countDraftMessages(b);

  // Tab A types into a question without saving: a draft lands in the shared store.
  const a = await context.newPage();
  await a.setViewportSize({ width: 1280, height: 900 });
  await gotoVerse(a, "ZEC", CHAPTER, tq.verse);
  await a.getByRole("button", { name: /^Questions/ }).click();
  const field = a.locator(`[data-question-id="${tq.id}"]`).locator('textarea:not([aria-hidden="true"])').first();
  await field.fill(`CROSS TAB DRAFT ${Date.now()}`);
  await expect(a.getByText(ONE_UNSAVED).first()).toBeVisible({ timeout: 15_000 });

  // Tab B, never reloaded, counts it.
  await expect(b.getByText(ONE_UNSAVED).first()).toBeVisible({ timeout: 10_000 });
  if (SHOTS) await b.screenshot({ path: `${SHOTS}/cross-tab-drafts-count-tab-b-unsaved.png` });

  // Tab A discards it from the "1 unsaved" jump menu (top-bar chip, then the
  // Status popover's chip, then the draft's discard button).
  await a.bringToFront();
  await a.getByText(ONE_UNSAVED).first().click();
  await a.getByRole("presentation").getByText(ONE_UNSAVED).click();
  await a.getByRole("button", { name: EN.sync.discardThisEdit }).click();
  await expect(a.getByText(ONE_UNSAVED)).toHaveCount(0);

  // Tab B's chip drops, and stays dropped.
  await expect(b.getByText(ONE_UNSAVED)).toHaveCount(0, { timeout: 10_000 });
  await b.waitForTimeout(1000);
  await expect(b.getByText(ONE_UNSAVED)).toHaveCount(0);
  if (SHOTS) await b.screenshot({ path: `${SHOTS}/cross-tab-drafts-count-tab-b.png` });

  // No ping-pong: hearing a change never posts another, so the channel goes
  // quiet once tab A stops writing.
  const settled = await heard();
  expect(settled, "tab B heard tab A's write and discard").toBeGreaterThanOrEqual(2);
  await b.waitForTimeout(1500);
  expect(await heard()).toBe(settled);
});
