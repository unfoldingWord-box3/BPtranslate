import { expect, test, type BrowserContext } from "@playwright/test";
import { authedRequest, fetchChapter, newUserContext, type TnRow } from "./helpers";

// Rapid check: the dense, keyboard-driven layout of the flows notes screen
// (#/notes), laptop size and up. It renders the same queue, cursor and editor
// as the card view, so this spec drives what is new: the toggle, J/K moving
// the cursor, Enter opening the editor, typed letters staying in the editor,
// Ctrl+Enter saving and approving, and the status circle approving a note
// that is not the open one.
//
// It WRITES (saves and approves notes), so it works on ZEC 3, a chapter no
// other spec in this suite opens.

const BOOK = "ZEC";
const CHAPTER = 3;

test.describe.configure({ timeout: 120_000 });

const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of openContexts.splice(0)) await c.close().catch(() => {});
});

type Row = TnRow & { translation_state?: string | null; trashed_at?: number | null };

test("rapid check: toggle, J/K, edit, Ctrl+Enter approve, circle approve", async ({ browser }) => {
  const { context, auth } = await newUserContext(browser, "rapid-check");
  openContexts.push(context);
  await context.addInitScript(() => {
    try {
      localStorage.removeItem("be:notesRapidCheck");
    } catch {
      /* private mode */
    }
  });

  // A verse with at least three live notes: one to edit and approve, one to
  // approve by its circle, and the order J/K walk.
  const chap = await fetchChapter(context.request, auth.token, BOOK, CHAPTER);
  const live = (chap.tn as Row[]).filter((r) => r.trashed_at == null && r.verse > 0);
  const byVerse = new Map<number, Row[]>();
  for (const r of live) byVerse.set(r.verse, [...(byVerse.get(r.verse) ?? []), r]);
  const verse = [...byVerse.keys()].sort((a, b) => a - b).find((v) => byVerse.get(v)!.length >= 3);
  expect(verse, `ZEC ${CHAPTER} needs a verse with 3+ notes`).toBeDefined();
  const rows = byVerse.get(verse!)!;
  // The queue order within a verse is sort_order; read it back from the page
  // rather than assuming it, below.

  // Make the third note "edited" on the server so its circle can approve it
  // without opening it (a fresh sample note has no draft state to approve).
  const api = authedRequest(context.request, auth.token, auth.csrf);
  const circleRow = rows[2];
  const circleText = `Circle approval test ${Date.now()}`;
  const patched = await api.patch(`/api/rows/tn/${circleRow.id}?book=${BOOK}`, { note: circleText }, circleRow.version);
  expect(patched.ok(), `PATCH ${circleRow.id}: ${patched.status()} ${await patched.text()}`).toBeTruthy();

  const page = await context.newPage();
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route("https://git.door43.org/**", (route) => route.fulfill({ status: 404, body: "not mocked" }));
  await page.goto(`/#/notes/${BOOK}/${CHAPTER}/${verse}?row=${rows[0].id}`);

  // Card view first; the toggle switches to rapid check.
  const toggle = page.getByRole("button", { name: "Rapid check", exact: true });
  await toggle.waitFor({ timeout: 20_000 });
  await toggle.click();
  const list = page.locator("[data-rapid-check]");
  await expect(list).toBeVisible();
  const listRows = list.locator("[data-rapid-row]");
  await expect(listRows).toHaveCount(rows.length);
  const ids = await listRows.evaluateAll((els) => els.map((el) => el.getAttribute("data-rapid-row")));
  const current = list.locator('[data-rapid-row][aria-current="true"]');
  await expect(current).toHaveAttribute("data-rapid-row", rows[0].id);

  // Start from the verse's first row (the deep link's row need not be first).
  await list.locator(`[data-rapid-select="${ids[0]}"]`).click();
  await expect(current).toHaveAttribute("data-rapid-row", ids[0]!);

  // J and K move the cursor once the list has focus.
  await list.focus();
  await page.keyboard.press("j");
  await expect(current).toHaveAttribute("data-rapid-row", ids[1]!);
  await page.keyboard.press("k");
  await expect(current).toHaveAttribute("data-rapid-row", ids[0]!);

  // Clicking a row's type/ref button makes it current and leaves focus on
  // that button. K still moves, and Enter, with focus still on the OTHER
  // row's button, edits the current note (not a click on that button).
  await list.locator(`[data-rapid-select="${ids[1]}"]`).click();
  await expect(current).toHaveAttribute("data-rapid-row", ids[1]!);
  await page.keyboard.press("k");
  await expect(current).toHaveAttribute("data-rapid-row", ids[0]!);

  // Enter opens the editor; letters typed there are text, not shortcuts.
  await page.keyboard.press("Enter");
  const editor = list.locator('textarea:not([aria-hidden="true"])');
  await expect(editor).toBeVisible();
  await editor.fill("");
  const edited = `Keyboard edit test ${Date.now()} jka`;
  await page.keyboard.type(edited);
  await expect(editor).toHaveValue(edited);
  await expect(current).toHaveAttribute("data-rapid-row", ids[0]!);

  // Ctrl+Enter saves, then approves (handleApprove's order).
  await page.keyboard.press("Control+Enter");
  await expect
    .poll(
      async () => {
        const c = await fetchChapter(context.request, auth.token, BOOK, CHAPTER);
        const r = (c.tn as Row[]).find((x) => x.id === ids[0]);
        return `${r?.translation_state}|${r?.note}`;
      },
      { timeout: 20_000 },
    )
    .toBe(`validated|${edited}`);
  // The editor closed; the keyboard is back in the list.
  await expect(editor).toBeHidden();
  await expect(list).toBeFocused();

  // Letters match the physical key: J under an Arabic layout (key "ت") moves.
  const before = await current.getAttribute("data-rapid-row");
  const beforeIdx = ids.indexOf(before);
  await list.dispatchEvent("keydown", { key: "ت", code: "KeyJ", bubbles: true });
  if (beforeIdx < ids.length - 1) {
    await expect(current).toHaveAttribute("data-rapid-row", ids[beforeIdx + 1]!);
  }

  // The status circle approves a note that is not the open one.
  const circle = list.locator(`[data-rapid-approve="${circleRow.id}"]`);
  await expect(circle).toBeEnabled();
  await circle.click();
  await expect
    .poll(
      async () => {
        const c = await fetchChapter(context.request, auth.token, BOOK, CHAPTER);
        return (c.tn as Row[]).find((x) => x.id === circleRow.id)?.translation_state;
      },
      { timeout: 20_000 },
    )
    .toBe("validated");
  await expect(circle).toBeDisabled();
  await expect(circle).toHaveAttribute("aria-label", "Approved");
  await expect(list).toBeFocused();

  await page.screenshot({ path: test.info().outputPath("rapid-check-1366x768.png") });
  // The choice is remembered for the next visit.
  expect(await page.evaluate(() => localStorage.getItem("be:notesRapidCheck"))).toBe("true");

  // Below 1200px the toggle is hidden and the card view returns, even with
  // the choice saved.
  await page.setViewportSize({ width: 1100, height: 768 });
  await expect(page.getByRole("button", { name: "Rapid check", exact: true })).toBeHidden();
  await expect(list).toBeHidden();
});
