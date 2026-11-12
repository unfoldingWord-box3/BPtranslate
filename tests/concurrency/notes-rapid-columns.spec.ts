import { expect, test, type BrowserContext } from "@playwright/test";
import { fetchChapter, newUserContext, type TnRow } from "./helpers";

// Rapid check's room-making controls: hiding a scripture lane from its chip,
// hiding the original-language quote column from its own header and bringing
// it back from the restore chip, both choices surviving a reload, and moving
// between verses with the [ and ] keys, the arrow buttons and the verse
// picker. Everything is driven from the keyboard except the picker. Then a
// click on a row's quote selects that row, and the editor's Close (keeps the
// typing as a draft) and Discard changes (back to the saved text).
//
// READ-ONLY on the server: lane and column choices are browser prefs, verse
// moves only move the cursor, and Close / Discard only touch this browser's
// drafts store. So it opens ZEC 3 (the rapid check chapter) without writing.

const BOOK = "ZEC";
const CHAPTER = 3;

test.describe.configure({ timeout: 120_000 });

const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of openContexts.splice(0)) await c.close().catch(() => {});
});

type Row = TnRow & { trashed_at?: number | null; sort_order?: number | null };

test("rapid check: hide lanes and the quote column, verse navigation, prefs persist", async ({ browser }) => {
  const { context, auth } = await newUserContext(browser, "rapid-columns");
  openContexts.push(context);
  // Start from the defaults once; later reloads must keep what the test set.
  await context.addInitScript(() => {
    try {
      if (!sessionStorage.getItem("rapid-columns-init")) {
        sessionStorage.setItem("rapid-columns-init", "1");
        localStorage.removeItem("be:rapidHiddenLanes");
        localStorage.removeItem("be:rapidHiddenColumns");
        localStorage.setItem("be:notesRapidCheck", "true");
      }
    } catch {
      /* private mode */
    }
  });

  // Verses with notes, in queue order. The chapter intro (verse 0) is a stop
  // too, the first one. Start on a real verse with a stop on either side.
  const chap = await fetchChapter(context.request, auth.token, BOOK, CHAPTER);
  const live = (chap.tn as Row[]).filter((r) => r.trashed_at == null && r.chapter === CHAPTER);
  const byVerse = new Map<number, string[]>();
  for (const r of live) byVerse.set(r.verse, [...(byVerse.get(r.verse) ?? []), r.id]);
  const verses = [...byVerse.keys()].sort((a, b) => a - b);
  const startAt = verses.findIndex((v, i) => v > 0 && i > 0);
  expect(startAt, `ZEC ${CHAPTER} needs a verse with stops on both sides`).toBeGreaterThan(0);
  expect(verses.length).toBeGreaterThan(startAt + 1);
  const [v1, v2, v3] = verses.slice(startAt - 1, startAt + 2);

  const page = await context.newPage();
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route("https://git.door43.org/**", (route) => route.fulfill({ status: 404, body: "not mocked" }));
  await page.goto(`/#/notes/${BOOK}/${CHAPTER}/${v2}`);

  const list = page.locator("[data-rapid-check]");
  await expect(list).toBeVisible({ timeout: 20_000 });
  const listRows = list.locator("[data-rapid-row]");
  const rowIds = () => listRows.evaluateAll((els) => els.map((el) => el.getAttribute("data-rapid-row")).sort());
  const idsOf = (v: number) => [...byVerse.get(v)!].sort();
  await expect.poll(rowIds).toEqual(idsOf(v2));

  // ── verse navigation ──────────────────────────────────────────────────
  await list.focus();
  await page.keyboard.press("BracketRight");
  await expect.poll(rowIds).toEqual(idsOf(v3));
  await page.keyboard.press("BracketLeft");
  await expect.poll(rowIds).toEqual(idsOf(v2));
  await page.keyboard.press("BracketLeft");
  await expect.poll(rowIds).toEqual(idsOf(v1));
  // The first stop has no previous one.
  if (startAt === 1) await expect(page.getByRole("button", { name: "Previous verse" })).toBeDisabled();
  // The arrow button, from the keyboard.
  await page.getByRole("button", { name: "Next verse" }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(rowIds).toEqual(idsOf(v2));
  // The picker lists the verses with notes and their counts.
  await page.getByRole("combobox", { name: "Go to verse" }).click();
  await page.getByRole("option", { name: `${CHAPTER}:${v3} (${byVerse.get(v3)!.length})` }).click();
  await expect.poll(rowIds).toEqual(idsOf(v3));

  // ── lanes ─────────────────────────────────────────────────────────────
  const block = page.locator("[data-rapid-verse-block]");
  const laneChips = block.locator("[data-rapid-lane-toggle]");
  await expect(laneChips).toHaveCount(2); // ULT and UST (no source lane here)
  const laneId = (await laneChips.first().getAttribute("data-rapid-lane-toggle"))!;
  const laneChip = block.locator(`[data-rapid-lane-toggle="${laneId}"]`);
  const laneText = block.locator(`[data-rapid-lane="${laneId}"]`);
  await expect(laneText).toBeVisible();
  await expect(laneChip).toHaveAttribute("aria-pressed", "true");
  await laneChip.focus();
  await page.keyboard.press("Enter");
  await expect(laneText).toHaveCount(0);
  await expect(laneChip).toHaveAttribute("aria-pressed", "false");
  // The chip stays, so the lane can come back; the other lane still shows.
  await expect(laneChip).toBeVisible();
  await expect(block.locator("[data-rapid-lane]")).toHaveCount(1);

  // ── quote column ──────────────────────────────────────────────────────
  const quoteCells = list.locator("[data-rapid-quote]");
  await expect(quoteCells.first()).toBeVisible();
  const hideQuote = page.getByRole("button", { name: "Hide the Hebrew column" });
  await hideQuote.focus();
  await page.keyboard.press("Enter");
  await expect(quoteCells).toHaveCount(0);
  // Focus moved to the restore chip that replaced the hide button.
  const showQuote = page.getByRole("button", { name: "Show the Hebrew column" });
  await expect(showQuote).toBeFocused();
  // Shortcuts still work from there.
  await page.keyboard.press("BracketLeft");
  await expect.poll(rowIds).toEqual(idsOf(v2));

  // ── both choices survive a reload ─────────────────────────────────────
  await page.reload();
  await expect(list).toBeVisible({ timeout: 20_000 });
  await expect(quoteCells).toHaveCount(0);
  await expect(laneText).toHaveCount(0);
  await expect(laneChip).toHaveAttribute("aria-pressed", "false");

  // Bring both back from the keyboard.
  await showQuote.focus();
  await page.keyboard.press("Enter");
  await expect(quoteCells.first()).toBeVisible();
  await expect(hideQuote).toBeFocused();
  await laneChip.focus();
  await page.keyboard.press("Enter");
  await expect(laneText).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("be:rapidHiddenColumns"))).toBe("[]");
  expect(await page.evaluate(() => localStorage.getItem("be:rapidHiddenLanes"))).toBe("[]");

  // The keyboard shortcut list opens from the column header.
  await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
  await expect(page.getByText("previous / next verse")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.screenshot({ path: test.info().outputPath("rapid-columns-1366x768.png") });

  // ── a click anywhere on a row selects it; Close and Discard ───────────
  const vMulti = verses.find((v) => v > 0 && byVerse.get(v)!.length >= 2);
  expect(vMulti, `ZEC ${CHAPTER} needs a verse with 2+ notes`).toBeDefined();
  await page.goto(`/#/notes/${BOOK}/${CHAPTER}/${vMulti}`);
  await expect.poll(rowIds).toEqual(idsOf(vMulti!));
  const current = list.locator('[data-rapid-row][aria-current="true"]');
  const other = list.locator('[data-rapid-row]:not([aria-current="true"])').first();
  const otherId = (await other.getAttribute("data-rapid-row"))!;
  await other.locator("[data-rapid-quote]").click();
  await expect(current).toHaveAttribute("data-rapid-row", otherId);
  await expect(list).toBeFocused();

  // Close keeps the typing as an unsaved draft (what Esc does).
  const editor = list.locator('textarea:not([aria-hidden="true"])');
  await page.keyboard.press("Enter");
  await expect(editor).toBeVisible();
  const saved = await editor.inputValue();
  const typed = `Close keeps this draft ${Date.now()}`;
  await editor.fill(typed);
  await list.getByRole("button", { name: "Close" }).click();
  await expect(editor).toBeHidden();
  await expect(current).toContainText(typed);
  await page.goto(`/#/notes/${BOOK}/${CHAPTER}/${vMulti}?row=${otherId}`);
  await page.reload();
  await expect(current).toHaveAttribute("data-rapid-row", otherId, { timeout: 20_000 });
  await expect(current).toContainText(typed);

  // Discard puts the saved text back, leaves the server alone, and no draft
  // returns after a reload.
  await list.focus();
  await page.keyboard.press("Enter");
  await expect(editor).toHaveValue(typed);
  await list.getByRole("button", { name: "Discard changes" }).click();
  await expect(editor).toBeHidden();
  await expect(current).not.toContainText(typed);
  const after = await fetchChapter(context.request, auth.token, BOOK, CHAPTER);
  const serverNote = (after.tn as Row[]).find((r) => r.id === otherId)?.note ?? "";
  expect(serverNote).not.toContain("Close keeps this draft");
  await page.reload();
  await expect(current).toHaveAttribute("data-rapid-row", otherId, { timeout: 20_000 });
  await list.focus();
  await page.keyboard.press("Enter");
  await expect(editor).toHaveValue(saved);
  await expect(list.getByRole("button", { name: "Discard changes" })).toHaveCount(0);
});
