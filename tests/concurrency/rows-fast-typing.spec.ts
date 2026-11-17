import { expect, test, type Page } from "@playwright/test";
import { newUserContext } from "./helpers";
import { ZEC_CHAPTERS } from "./chapters";

// Issue #903. In the classic rows view every keystroke in a verse box writes a
// draft to IndexedDB, and the box's drafts subscriber used to copy the stored
// draft's text into the box the first time a draft showed up for that verse.
// The store notifies asynchronously, so that first notification could carry a
// draft from an earlier keystroke than the one already on screen: the box was
// overwritten with older text, the caret jumped to the start, and later typing
// landed there. Typing " AAA" fast then " BBB" gave e.g. " BBB<verse> A".
//
// The race does not fire every time (about 1 verse in 5 before the fix), so
// one test types into 16 verses in turn. Every other verse first gets a draft
// and an Undo, because Undo used to re-arm the same overwrite. Nothing is
// saved, so the chapter's server data is never changed.
const CHAPTER = ZEC_CHAPTERS.rowsFastTyping.chapter;
const VERSES = Array.from({ length: 16 }, (_, i) => i + 1);

function verseBox(page: Page, verse: number) {
  return page.locator(`[data-find-cell="${CHAPTER}-${verse}-ULT"][contenteditable="true"]`).first();
}

async function openVerse(page: Page, verse: number) {
  await page.goto(`/#/ZEC/${CHAPTER}/${verse}`);
  await verseBox(page, verse).waitFor({ timeout: 15_000 });
}

test.describe("Rows view: fast typing in a verse box (#903)", () => {
  test("fast typing keeps every character and the caret at the end", async ({ browser }) => {
    test.setTimeout(VERSES.length * 15_000 + 30_000);
    const { context } = await newUserContext(browser, "typing-903");
    const page = await context.newPage();
    const failures: string[] = [];
    try {
      for (const verse of VERSES) {
        await openVerse(page, verse);
        const box = verseBox(page, verse);
        if (verse % 2 === 0) {
          // Every other verse first gets a draft and an Undo, so the fast
          // typing below starts from a box that has already held a draft.
          await box.click();
          await page.keyboard.press("Control+End");
          await page.keyboard.type("X", { delay: 50 });
          await expect(box).toHaveAttribute("data-dirty", "true");
          await page.waitForTimeout(300);
          await box.locator("xpath=..").getByRole("button", { name: "undo edits to this verse" }).click();
          await expect(box).not.toHaveAttribute("data-dirty", "true");
        }
        const before = (await box.textContent()) ?? "";
        await box.click();
        await page.keyboard.press("Control+End");
        await page.keyboard.type(" AAA");
        await page.waitForTimeout(1500);
        await page.keyboard.type(" BBB");
        await page.waitForTimeout(1500);
        const after = (await box.textContent()) ?? "";
        // Where Control+End lands depends on the verse's trailing marker
        // chips, and typing there drops a trailing newline, so check that
        // " AAA BBB" went in whole, in one place, and nothing else changed.
        if (!after.includes(" AAA BBB") || after.replace(" AAA BBB", "").trimEnd() !== before.trimEnd()) {
          failures.push(`${CHAPTER}:${verse} got ${JSON.stringify(after.slice(0, 40))}…${JSON.stringify(after.slice(-40))}`);
        }
      }
    } finally {
      await context.close();
    }
    expect(failures, `${failures.length} of ${VERSES.length} verses lost typing`).toEqual([]);
  });

  test("a stored verse draft is still restored when the box opens", async ({ browser }) => {
    const verse = VERSES.length + 1;
    const { context } = await newUserContext(browser, "typing-903-restore");
    const page = await context.newPage();
    try {
      await openVerse(page, verse);
      const box = verseBox(page, verse);
      const before = (await box.textContent()) ?? "";
      await box.click();
      await page.keyboard.press("Control+End");
      // Slow typing, so this case does not depend on the #903 race.
      await page.keyboard.type(" RESTORED", { delay: 50 });
      // Let the draft reach IndexedDB, then reopen the chapter from scratch.
      await expect(box).toHaveAttribute("data-dirty", "true");
      await page.waitForTimeout(500);
      const typed = (await box.textContent()) ?? "";
      expect(typed.replace(" RESTORED", "").trimEnd()).toBe(before.trimEnd());
      await page.reload();
      const reopened = verseBox(page, verse);
      await reopened.waitFor({ timeout: 15_000 });
      await expect(reopened).toHaveText(typed);
      await expect(reopened).toHaveAttribute("data-dirty", "true");
    } finally {
      await context.close();
    }
  });
});
