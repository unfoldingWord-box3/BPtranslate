import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { fetchChapter, newUserContext, type TnRow } from "./helpers";

// Rapid check follow-ups (#831): the quote picker on the open row (pencil and
// Q), taking an approval back by clicking an approved circle, and the compact
// lanes drawn above every verse group in type-filter mode.
//
// It WRITES (quotes, approvals), so it works on ZEC 13, a chapter no other
// spec opens. global-setup seeds its notes as ai_draft so they can be approved.

const BOOK = "ZEC";
const CHAPTER = 13;

test.describe.configure({ timeout: 120_000 });

const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of openContexts.splice(0)) await c.close().catch(() => {});
});

type Row = TnRow & {
  translation_state?: string | null;
  trashed_at?: number | null;
  support_reference?: string | null;
};

const slugOf = (ref: string | null | undefined) => (ref ?? "").split("/").pop() ?? "";

async function openRapid(browser: Parameters<typeof newUserContext>[0], name: string, hashTail: string) {
  const { context, auth } = await newUserContext(browser, name);
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
  return { context, auth, page, list };
}

async function serverRow(page: Page, token: string, id: string): Promise<Row | undefined> {
  const c = await fetchChapter(page.context().request, token, BOOK, CHAPTER);
  return (c.tn as Row[]).find((x) => x.id === id);
}

test("rapid check: Q opens the quote picker and the new quote reaches the server", async ({ browser }) => {
  const probe = await newUserContext(browser, "rapid-quote-probe");
  openContexts.push(probe.context);
  const chap = await fetchChapter(probe.context.request, probe.auth.token, BOOK, CHAPTER);
  const live = (chap.tn as Row[]).filter((r) => r.trashed_at == null && r.verse > 0 && (r.quote ?? "") !== "");
  const target = live[0];
  expect(target, `ZEC ${CHAPTER} needs a note with a quote`).toBeDefined();

  const { auth, page, list } = await openRapid(browser, "rapid-quote", `${target.verse}?row=${target.id}`);
  const current = list.locator('[data-rapid-row][aria-current="true"]');
  await expect(current).toHaveAttribute("data-rapid-row", target.id);

  // The pencil sits in the open row's quote cell only.
  await expect(list.locator("[data-rapid-quote-pick]")).toHaveCount(1);
  await expect(list.locator(`[data-rapid-quote-pick="${target.id}"]`)).toBeVisible();

  // Q (by physical key) opens the picker and moves focus into it.
  await list.focus();
  await list.dispatchEvent("keydown", { key: "ض", code: "KeyQ", bubbles: true });
  const picker = page.getByRole("dialog", { name: new RegExp(`${BOOK} ${CHAPTER}:${target.verse}`) });
  await expect(picker).toBeVisible();
  await expect(picker).toBeFocused();

  // Esc closes it; focus returns to the pencil, where Q works again.
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await page.keyboard.press("q");
  await expect(picker).toBeVisible();

  // Add one more source word to the quote, then use the selection.
  await picker.locator(".MuiChip-outlined").first().click();
  await picker.getByRole("button", { name: "Use selection" }).click();
  await expect(picker).toBeHidden();
  await expect
    .poll(async () => (await serverRow(page, auth.token, target.id))?.quote, { timeout: 20_000 })
    .not.toBe(target.quote);
  const saved = await serverRow(page, auth.token, target.id);
  // The row on screen shows the server's new quote.
  await expect(current).toContainText(saved!.quote!);
  // A quote change is an edit: the AI draft is now 'edited'.
  expect(saved!.translation_state).toBe("edited");

  // With the original-language column hidden (no pencil), Q still opens the
  // picker, anchored to the open row's type button.
  await page.getByRole("button", { name: "Hide the Hebrew column" }).click();
  await expect(list.locator("[data-rapid-quote-pick]")).toHaveCount(0);
  await list.focus();
  await page.keyboard.press("q");
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await page.getByRole("button", { name: "Show the Hebrew column" }).click();
  await expect(list.locator("[data-rapid-quote-pick]")).toHaveCount(1);
  await list.focus();

  // Focus came back to the list's keyboard handling.
  const ids = await list
    .locator("[data-rapid-row]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-rapid-row")));
  const at = ids.indexOf(target.id);
  if (at < ids.length - 1) {
    await page.keyboard.press("j");
    await expect(current).toHaveAttribute("data-rapid-row", ids[at + 1]!);
  }
});

test("rapid check: clicking an approved circle takes the approval back", async ({ browser }) => {
  const probe = await newUserContext(browser, "rapid-unapprove-probe");
  openContexts.push(probe.context);
  const chap = await fetchChapter(probe.context.request, probe.auth.token, BOOK, CHAPTER);
  const live = (chap.tn as Row[]).filter((r) => r.trashed_at == null && r.verse > 0);
  const byVerse = new Map<number, Row[]>();
  for (const r of live) byVerse.set(r.verse, [...(byVerse.get(r.verse) ?? []), r]);
  // A verse with two notes, away from the quote test's first note.
  const verse = [...byVerse.keys()]
    .sort((a, b) => b - a)
    .find((v) => byVerse.get(v)!.length >= 2 && byVerse.get(v)!.every((r) => r.translation_state === "ai_draft"));
  expect(verse, `ZEC ${CHAPTER} needs a verse with 2+ AI-draft notes`).toBeDefined();
  const [openRow, other] = byVerse.get(verse!)!;

  const { auth, page, list } = await openRapid(browser, "rapid-unapprove", `${verse}?row=${openRow.id}`);
  const circle = list.locator(`[data-rapid-approve="${other.id}"]`);
  await expect(circle).toBeEnabled();

  // A double-click approves once; its second click does not undo it.
  await circle.dblclick();
  await expect
    .poll(async () => (await serverRow(page, auth.token, other.id))?.translation_state, { timeout: 20_000 })
    .toBe("validated");
  await expect(circle).toHaveAttribute("aria-label", "Approved. Click to remove the approval");
  await page.waitForTimeout(1000);
  expect((await serverRow(page, auth.token, other.id))?.translation_state).toBe("validated");

  // One click on the approved circle: the row goes back to 'edited' (a person
  // reviewed it), the circle can approve again, and a notice says so.
  await expect(circle).toBeEnabled();
  await circle.click();
  await expect
    .poll(async () => (await serverRow(page, auth.token, other.id))?.translation_state, { timeout: 20_000 })
    .toBe("edited");
  await expect(page.getByText("Approval removed")).toBeVisible();
  await expect(circle).toHaveAttribute("aria-label", /^Approve note /);
  await expect(circle).toBeEnabled();
  await expect(list).toBeFocused();

  // And it can be approved again from there.
  await circle.click();
  await expect
    .poll(async () => (await serverRow(page, auth.token, other.id))?.translation_state, { timeout: 20_000 })
    .toBe("validated");

  // With a row checked (the bulk bar replaces the footer, #829), the circle
  // still takes the approval back and Q still opens the quote picker.
  await list.locator(`[data-rapid-checkbox="${openRow.id}"]`).click();
  await expect(page.locator("[data-rapid-bulk-bar]")).toBeVisible();
  await circle.click();
  await expect
    .poll(async () => (await serverRow(page, auth.token, other.id))?.translation_state, { timeout: 20_000 })
    .toBe("edited");
  await expect(page.locator("[data-rapid-bulk-bar]")).toBeVisible();
  await list.focus();
  await page.keyboard.press("q");
  await expect(page.getByRole("dialog", { name: new RegExp(`${BOOK} ${CHAPTER}:${verse}`) })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("rapid check: type-filter mode draws lanes above every verse group", async ({ browser }) => {
  const probe = await newUserContext(browser, "rapid-lanes-probe");
  openContexts.push(probe.context);
  const chap = await fetchChapter(probe.context.request, probe.auth.token, BOOK, CHAPTER);
  const live = (chap.tn as Row[]).filter((r) => r.trashed_at == null);
  // The type with the most verse groups in this chapter.
  const versesBySlug = new Map<string, Set<number>>();
  for (const r of live) {
    const slug = slugOf(r.support_reference);
    if (!slug || r.verse <= 0) continue;
    versesBySlug.set(slug, (versesBySlug.get(slug) ?? new Set()).add(r.verse));
  }
  const [slug, verses] = [...versesBySlug.entries()].sort((a, b) => b[1].size - a[1].size)[0];
  expect(verses.size, `ZEC ${CHAPTER} needs a type spanning 2+ verses`).toBeGreaterThanOrEqual(2);
  const first = live.find((r) => slugOf(r.support_reference) === slug)!;

  const { page, list } = await openRapid(browser, "rapid-lanes", `${first.verse}?row=${first.id}`);
  // No filter: no group heads, no group lanes.
  await expect(list.locator("[data-rapid-lanes]")).toHaveCount(0);

  await page.locator('[aria-label="Filter notes by type"] [role="combobox"]').click();
  await page.locator(`li[role="option"][title="${slug}"]`).click();

  const groups = list.locator("[data-rapid-lanes]");
  await expect(groups).toHaveCount(verses.size);
  for (const v of verses) {
    const lanes = list.locator(`[data-rapid-lanes="${v}"]`);
    const lit = lanes.locator('[data-rapid-group-lane-text="lit"]');
    await expect(lit).toBeVisible();
    await expect(lit).not.toBeEmpty();
    // The lanes sit in the group head, right above the group's first row.
    const nextIsRow = await list
      .locator(`[data-rapid-group="${v}"]`)
      .evaluate((el) => el.nextElementSibling?.hasAttribute("data-rapid-row") ?? false);
    expect(nextIsRow).toBe(true);
  }
  // Each listed note's quote is marked in its verse's lanes (where the
  // alignment resolves it; the sample ULT is aligned, so most do).
  expect(await groups.locator("mark").count()).toBeGreaterThan(0);

  // Hiding a lane with its chip in the pinned block hides it in every group
  // too (the same be:rapidHiddenLanes pref); showing it brings it back.
  const litChip = page.locator("[data-rapid-verse-block] [data-rapid-lane-toggle]", { hasText: "ULT" });
  await litChip.click();
  await expect(groups.locator('[data-rapid-group-lane-text="lit"]')).toHaveCount(0);
  await expect(groups.locator('[data-rapid-group-lane="sim"]')).toHaveCount(verses.size);
  await litChip.click();
  await expect(groups.locator('[data-rapid-group-lane-text="lit"]')).toHaveCount(verses.size);

  await page.screenshot({ path: test.info().outputPath("rapid-lanes-1366x768.png") });
});
