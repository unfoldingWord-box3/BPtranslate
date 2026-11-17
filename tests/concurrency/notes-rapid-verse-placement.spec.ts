import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { fetchChapter, newUserContext, type TnRow } from "./helpers";
import { ZEC_CHAPTERS } from "./chapters";

// Rapid check's verse placement (be:rapidVersePlacement): the open note's
// verse pinned at the top (the default), or each verse group's lanes inline
// above its notes. Never both, so a type filter no longer draws the open
// note's verse twice.
//
// READ-ONLY on ZEC 13 (notes-rapid-lanes writes there, so the type and verse
// set are read from the server at run time). Nothing here saves a note.

const BOOK = "ZEC";
const CHAPTER = ZEC_CHAPTERS.rapidLanes.chapter;

test.describe.configure({ timeout: 120_000 });

const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of openContexts.splice(0)) await c.close().catch(() => {});
});

type Row = TnRow & { trashed_at?: number | null; support_reference?: string | null };

const slugOf = (ref: string | null | undefined) => (ref ?? "").split("/").pop() ?? "";

async function pickType(browser: Parameters<typeof newUserContext>[0]) {
  const probe = await newUserContext(browser, "rapid-vp-probe");
  openContexts.push(probe.context);
  const chap = await fetchChapter(probe.context.request, probe.auth.token, BOOK, CHAPTER);
  const live = (chap.tn as Row[]).filter((r) => r.trashed_at == null);
  const versesBySlug = new Map<string, Set<number>>();
  for (const r of live) {
    const slug = slugOf(r.support_reference);
    if (!slug || r.verse <= 0) continue;
    versesBySlug.set(slug, (versesBySlug.get(slug) ?? new Set()).add(r.verse));
  }
  const [slug, verses] = [...versesBySlug.entries()].sort((a, b) => b[1].size - a[1].size)[0];
  expect(verses.size, `ZEC ${CHAPTER} needs a type spanning 2+ verses`).toBeGreaterThanOrEqual(2);
  const first = live.find((r) => r.verse > 0 && slugOf(r.support_reference) === slug)!;
  // An intro note of the type gets a group head too (with no lanes).
  const hasIntro = live.some((r) => r.verse === 0 && slugOf(r.support_reference) === slug);
  return { slug, verses, first, groupHeads: verses.size + (hasIntro ? 1 : 0) };
}

async function openRapid(browser: Parameters<typeof newUserContext>[0], name: string, hashTail: string) {
  const { context } = await newUserContext(browser, name);
  openContexts.push(context);
  await context.addInitScript(() => {
    try {
      localStorage.setItem("be:notesRapidCheck", "true");
    } catch {
      /* private mode */
    }
  });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route("https://git.door43.org/**", (route) => route.fulfill({ status: 404, body: "not mocked" }));
  await page.goto(`/#/notes/${BOOK}/${CHAPTER}/${hashTail}`);
  const list = page.locator("[data-rapid-check]");
  await expect(list).toBeVisible({ timeout: 20_000 });
  return { page, list };
}

// The two places a verse's text can be drawn.
const pinnedLanes = (page: Page) => page.locator("[data-rapid-verse-block] [data-rapid-lane]");
const inlineGroups = (page: Page) => page.locator("[data-rapid-check] [data-rapid-lanes]");
const option = (page: Page, which: "top" | "inline") =>
  page.locator(`[data-rapid-verse-placement-option="${which}"]`);

test("rapid check: verse on top by default, inline on request, and it survives reload", async ({ browser }) => {
  const { first } = await pickType(browser);
  const { page, list } = await openRapid(browser, "rapid-vp-default", `${first.verse}?row=${first.id}`);
  const current = list.locator('[data-rapid-row][aria-current="true"]');
  await expect(current).toHaveAttribute("data-rapid-row", first.id);

  // Default: the pinned block carries the verse; no inline lanes.
  await expect(option(page, "top")).toHaveAttribute("aria-pressed", "true");
  await expect(option(page, "inline")).toHaveAttribute("aria-pressed", "false");
  await expect(pinnedLanes(page).first()).toBeVisible();
  await expect(inlineGroups(page)).toHaveCount(0);
  const pinnedMarks = await page.locator("[data-rapid-verse-block] mark").count();

  // Inline: no verse text pinned; one group (the open verse) with its lanes
  // right above its first row. The controls and lane chips stay pinned.
  await option(page, "inline").click();
  await expect(option(page, "inline")).toHaveAttribute("aria-pressed", "true");
  await expect(pinnedLanes(page)).toHaveCount(0);
  await expect(page.locator("[data-rapid-verse-block] [data-rapid-lane-toggle]").first()).toBeVisible();
  await expect(page.locator("[data-rapid-verse-picker]")).toBeVisible();
  await expect(inlineGroups(page)).toHaveCount(1);
  const group = list.locator(`[data-rapid-lanes="${first.verse}"]`);
  await expect(group.locator('[data-rapid-group-lane-text="lit"]')).not.toBeEmpty();
  const nextIsRow = await list
    .locator(`[data-rapid-group="${first.verse}"]`)
    .evaluate((el) => el.nextElementSibling?.hasAttribute("data-rapid-row") ?? false);
  expect(nextIsRow).toBe(true);
  // The open note's quote is marked inline exactly as it was in the pinned
  // lanes (same lanes, same one quote), and its row is still current.
  await expect(group.locator("mark")).toHaveCount(pinnedMarks);
  await expect(current).toHaveAttribute("data-rapid-row", first.id);

  await page.screenshot({ path: test.info().outputPath("rapid-inline-1366x768.png") });

  // The choice is remembered in this browser.
  await page.reload();
  await expect(list).toBeVisible({ timeout: 20_000 });
  await expect(option(page, "inline")).toHaveAttribute("aria-pressed", "true");
  await expect(pinnedLanes(page)).toHaveCount(0);
  await expect(inlineGroups(page)).toHaveCount(1);

  // Back to top.
  await option(page, "top").click();
  await expect(inlineGroups(page)).toHaveCount(0);
  await expect(pinnedLanes(page).first()).toBeVisible();
});

test("rapid check: with a type filter, each placement draws the verse once", async ({ browser }) => {
  const { slug, verses, first, groupHeads } = await pickType(browser);
  const { page, list } = await openRapid(browser, "rapid-vp-filter", `${first.verse}?row=${first.id}`);

  await page.locator('[aria-label="Filter notes by type"] [role="combobox"]').click();
  await page.locator(`li[role="option"][title="${slug}"]`).click();
  await expect(list.locator("[data-rapid-group]")).toHaveCount(groupHeads);

  // Top: only the pinned block; the verse groups are thin dividing lines
  // (the ref stays for screen readers), no lanes.
  await expect(pinnedLanes(page).first()).toBeVisible();
  await expect(inlineGroups(page)).toHaveCount(0);
  const head = list.locator("[data-rapid-group]").first();
  expect((await head.boundingBox())?.height ?? 99).toBeLessThanOrEqual(6);
  await expect(head).toContainText("ZEC");
  await page.screenshot({ path: test.info().outputPath("rapid-top-filter-1366x768.png") });

  // Inline (by the V key, from the list): every group gets its lanes, the
  // pinned block none.
  await list.focus();
  await page.keyboard.press("v");
  await expect(option(page, "inline")).toHaveAttribute("aria-pressed", "true");
  await expect(pinnedLanes(page)).toHaveCount(0);
  await expect(inlineGroups(page)).toHaveCount(verses.size);
  for (const v of verses) {
    await expect(list.locator(`[data-rapid-lanes="${v}"] [data-rapid-group-lane-text="lit"]`)).not.toBeEmpty();
  }
  await page.screenshot({ path: test.info().outputPath("rapid-inline-filter-1366x768.png") });

  // V again: back to top, still no duplicate.
  await page.keyboard.press("v");
  await expect(option(page, "top")).toHaveAttribute("aria-pressed", "true");
  await expect(inlineGroups(page)).toHaveCount(0);
  await expect(pinnedLanes(page).first()).toBeVisible();
});

test("rapid check: the placement toggle is reachable by Tab, and hidden lanes stay hidden inline", async ({
  browser,
}) => {
  const { first } = await pickType(browser);
  const { page, list } = await openRapid(browser, "rapid-vp-keys", `${first.verse}?row=${first.id}`);

  // Tab from the list's start lands on the toggle's buttons within the
  // pinned header (it sits on the verse block's control line).
  await list.focus();
  let reached = false;
  for (let i = 0; i < 30 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(
      () => document.activeElement?.getAttribute("data-rapid-verse-placement-option") === "inline",
    );
  }
  expect(reached, "Tab should reach the Inline button").toBe(true);
  // Space presses it and checks no note (the list's Space-to-check skips buttons).
  await page.keyboard.press("Space");
  await expect(option(page, "inline")).toHaveAttribute("aria-pressed", "true");
  await expect(list.locator('[data-rapid-checkbox][aria-checked="true"]')).toHaveCount(0);
  await expect(inlineGroups(page)).toHaveCount(1);
  // Shift+Tab back to Top, Enter presses it.
  await page.keyboard.press("Shift+Tab");
  await expect(option(page, "top")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(option(page, "top")).toHaveAttribute("aria-pressed", "true");
  await expect(inlineGroups(page)).toHaveCount(0);

  // A lane hidden with its chip stays hidden in the inline lanes.
  await option(page, "inline").click();
  const group = list.locator(`[data-rapid-lanes="${first.verse}"]`);
  await expect(group.locator('[data-rapid-group-lane="lit"]')).toHaveCount(1);
  const litChip = page.locator("[data-rapid-verse-block] [data-rapid-lane-toggle]", { hasText: "ULT" });
  await litChip.click();
  await expect(litChip).toHaveAttribute("aria-pressed", "false");
  await expect(group.locator('[data-rapid-group-lane="lit"]')).toHaveCount(0);
  await expect(group.locator('[data-rapid-group-lane="sim"]')).toHaveCount(1);
  await litChip.click();
  await expect(group.locator('[data-rapid-group-lane="lit"]')).toHaveCount(1);
});
