import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { authedRequest, closeTolerant, fetchChapter, newUserContext, type TnRow } from "./helpers";

// Rapid check bulk actions (#829): checkboxes with Shift+click ranges,
// select-all, Space / X / Shift+J to check from the keyboard, and the bulk
// Approve and Not needed verbs with Undo for Not needed.
//
// It WRITES (approves, sets notes aside, restores them), so it works on
// ZEC 4, a chapter no other spec in this suite opens. global-setup seeds
// ZEC 4's notes as AI drafts so they can be approved.

const BOOK = "ZEC";
const CHAPTER = 4;

test.describe.configure({ timeout: 120_000 });

const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of openContexts.splice(0)) await c.close().catch(() => {});
});

type Row = TnRow & { translation_state?: string | null; trashed_at?: number | null };

async function serverRows(context: BrowserContext, token: string): Promise<Map<string, Row>> {
  const c = await fetchChapter(context.request, token, BOOK, CHAPTER);
  return new Map((c.tn as Row[]).map((r) => [r.id, r]));
}

// Put a note's text back after a test edited it, pinned to its current
// version. Its translation_state stays where the edit left it ('edited').
async function restoreNoteText(api: ReturnType<typeof authedRequest>, id: string, note: string, version: number) {
  const res = await api.patch(`/api/rows/tn/${id}?book=${BOOK}`, { note }, version);
  expect(res.status(), `restore ${id}`).toBe(200);
}

async function openRapid(page: Page, verse: number, rowId: string) {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route("https://git.door43.org/**", (route) => route.fulfill({ status: 404, body: "not mocked" }));
  await page.goto(`/#/notes/${BOOK}/${CHAPTER}/${verse}?row=${rowId}`);
  const list = page.locator("[data-rapid-check]");
  await expect(list).toBeVisible({ timeout: 20_000 });
  return list;
}

test("rapid check bulk: Shift+click approve skips a stored draft; Not needed then Undo", async ({ browser }) => {
  const { context, auth } = await newUserContext(browser, "rapid-bulk");
  openContexts.push(context);
  await context.addInitScript(() => {
    try {
      localStorage.setItem("be:notesRapidCheck", "true");
    } catch {
      /* private mode */
    }
  });

  const chap = await fetchChapter(context.request, auth.token, BOOK, CHAPTER);
  const live = (chap.tn as Row[]).filter((r) => r.trashed_at == null && r.verse > 0);
  const byVerse = new Map<number, Row[]>();
  for (const r of live) byVerse.set(r.verse, [...(byVerse.get(r.verse) ?? []), r]);
  const verse = [...byVerse.keys()].sort((a, b) => a - b).find((v) => byVerse.get(v)!.length >= 4);
  expect(verse, `ZEC ${CHAPTER} needs a verse with 4+ notes`).toBeDefined();
  const verseRows = byVerse.get(verse!)!;
  for (const r of verseRows) expect(r.translation_state, `seeded ai_draft for ${r.id}`).toBe("ai_draft");

  const page = await context.newPage();
  const list = await openRapid(page, verse!, verseRows[0].id);
  const listRows = list.locator("[data-rapid-row]");
  await expect(listRows).toHaveCount(verseRows.length);
  const ids = (await listRows.evaluateAll((els) => els.map((el) => el.getAttribute("data-rapid-row")))) as string[];
  const box = (id: string) => list.locator(`[data-rapid-checkbox="${id}"]`);
  const current = list.locator('[data-rapid-row][aria-current="true"]');

  // A stored draft on the fourth note: open it, type, close the editor, and
  // move the cursor away. The typing waits in the drafts store.
  await list.locator(`[data-rapid-row="${ids[3]}"] button:not([data-rapid-approve]):not([data-rapid-select]):not([data-rapid-checkbox])`).click();
  const editor = list.locator('textarea:not([aria-hidden="true"])');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" unsaved bulk typing");
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await list.locator(`[data-rapid-select="${ids[0]}"]`).click();
  await expect(current).toHaveAttribute("data-rapid-row", ids[0]);
  await expect(list.locator(`[data-rapid-approve="${ids[3]}"]`)).toHaveAttribute(
    "aria-label",
    "This note has unsaved typing. Open it and use Save & Approve.",
  );
  // The app's "Unsaved: ..." reminder (#372) sits over the bottom bar; close it.
  const reminder = page.getByRole("status").filter({ hasText: "Unsaved:" });
  await reminder.getByRole("button", { name: "dismiss" }).click();
  await expect(reminder).toHaveCount(0);

  // No bulk bar until something is checked.
  const bar = page.locator("[data-rapid-bulk-bar]");
  await expect(bar).toHaveCount(0);

  // Select-all checks every note shown, and unchecks them again.
  const all = list.getByRole("checkbox", { name: "Check all notes shown" });
  await all.click();
  await expect(bar).toContainText(`Checked: ${ids.length}`);
  await all.click();
  await expect(bar).toHaveCount(0);

  // Click the first note's box, Shift+click the fourth: four checked.
  await box(ids[0]).click();
  await expect(all).toHaveAttribute("aria-checked", "mixed");
  await box(ids[3]).click({ modifiers: ["Shift"] });
  await expect(bar).toContainText("Checked: 4");
  for (const id of ids.slice(0, 4)) await expect(box(id)).toHaveAttribute("aria-checked", "true");

  // Approve: the three clean notes are approved, the drafted one is skipped
  // and reported, and stays checked.
  await page.screenshot({ path: test.info().outputPath("rapid-bulk-selected-1366x768.png") });
  await bar.getByRole("button", { name: "Approve", exact: true }).click();
  const result = page.locator("[data-rapid-bulk-result]");
  await expect(result).toContainText("Approved: 3. Skipped: 1 (unsaved typing: 1).", { timeout: 20_000 });
  let server = await serverRows(context, auth.token);
  for (const id of ids.slice(0, 3)) expect(server.get(id)?.translation_state, id).toBe("validated");
  expect(server.get(ids[3])?.translation_state).toBe("ai_draft");
  await expect(box(ids[3])).toHaveAttribute("aria-checked", "true");
  await expect(bar).toContainText("Checked: 1");
  // Approve offers no Undo: un-approving would not restore the AI-draft state.
  await expect(result.getByRole("button", { name: "Undo" })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("rapid-bulk-approved-1366x768.png") });

  // This is not a translation workspace, so bulk Redo is off, with the reason.
  const redoBtn = bar.getByRole("button", { name: "Redo with AI" });
  await expect(redoBtn).toBeDisabled();
  await expect(redoBtn).toHaveAttribute("title", /only in a translation workspace/);

  // Keyboard: Clear, then Space checks the current note and Shift+J extends.
  await bar.getByRole("button", { name: "Clear" }).click();
  await expect(bar).toHaveCount(0);
  // Space on a focused checkbox toggles it exactly once (click, then Space).
  await box(ids[1]).click();
  await expect(box(ids[1])).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Space");
  await expect(box(ids[1])).toHaveAttribute("aria-checked", "false");
  await expect(bar).toHaveCount(0);
  await list.focus();
  await page.keyboard.press("Space");
  await expect(box(ids[0])).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Shift+KeyJ");
  await expect(current).toHaveAttribute("data-rapid-row", ids[1]);
  await expect(box(ids[1])).toHaveAttribute("aria-checked", "true");
  // X toggles the current note: off, then on again.
  await page.keyboard.press("x");
  await expect(box(ids[1])).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("x");
  await expect(bar).toContainText("Checked: 2");

  // Not needed sets both aside; Undo (Ctrl+Z) brings them back, approved.
  await bar.getByRole("button", { name: "Not needed", exact: true }).click();
  await expect(result).toContainText("Marked not needed: 2.", { timeout: 20_000 });
  server = await serverRows(context, auth.token);
  for (const id of ids.slice(0, 2)) expect(server.get(id)?.trashed_at, id).not.toBeNull();
  await expect(result.getByRole("button", { name: "Undo" })).toBeVisible();
  await list.focus();
  await page.keyboard.press("Control+z");
  await expect(result).toContainText("Restored: 2.", { timeout: 20_000 });
  server = await serverRows(context, auth.token);
  for (const id of ids.slice(0, 2)) {
    expect(server.get(id)?.trashed_at, id).toBeNull();
    expect(server.get(id)?.translation_state, id).toBe("validated");
    await expect(list.locator(`[data-rapid-approve="${id}"]`)).toHaveAttribute("aria-label", "Approved. Click to remove the approval");
  }
  await expect(result.getByRole("button", { name: "Undo" })).toHaveCount(0);
});

test("rapid check bulk: Arabic UI draws the checkboxes and bar right to left", async ({ browser }) => {
  const { context, auth } = await newUserContext(browser, "rapid-bulk-ar");
  openContexts.push(context);
  await context.addInitScript(() => {
    try {
      localStorage.setItem("be:notesRapidCheck", "true");
      localStorage.setItem("be:uiLang", "ar");
    } catch {
      /* private mode */
    }
  });
  const chap = await fetchChapter(context.request, auth.token, BOOK, CHAPTER);
  const first = (chap.tn as Row[]).find((r) => r.trashed_at == null && r.verse > 0)!;
  const page = await context.newPage();
  const list = await openRapid(page, first.verse, first.id);
  const ids = (await list.locator("[data-rapid-row]").evaluateAll((els) => els.map((el) => el.getAttribute("data-rapid-row")))) as string[];
  await list.locator(`[data-rapid-checkbox="${ids[0]}"]`).click();
  await list.locator(`[data-rapid-checkbox="${ids[ids.length - 1]}"]`).click({ modifiers: ["Shift"] });
  const bar = page.locator("[data-rapid-bulk-bar]");
  await expect(bar).toContainText(`المحدد: ${ids.length}`);
  // Right to left: the checkbox column is the row's rightmost cell, right of
  // the approve circle.
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const boxX = (await list.locator(`[data-rapid-checkbox="${ids[0]}"]`).boundingBox())!.x;
  const circleX = (await list.locator(`[data-rapid-approve="${ids[0]}"]`).boundingBox())!.x;
  expect(boxX).toBeGreaterThan(circleX);
  // Read-only test: nothing is approved here.
  await page.screenshot({ path: test.info().outputPath("rapid-bulk-ar-1366x768.png") });
});

// #837: bulk Not needed pins each trash to the version on screen. A peer's
// edit that lands after the bulk action's chapter re-read (the gap #836 left
// open) is refused by the server, and the note is skipped and reported, not
// set aside unseen. The peer PATCH runs inside the route handler for that
// note's trash request, so it lands after every client-side check.
test("rapid check bulk: Not needed skips a note a peer edited just before its trash", async ({ browser }) => {
  const { context, auth } = await newUserContext(browser, "rapid-bulk-pin");
  openContexts.push(context);
  await context.addInitScript(() => {
    try {
      localStorage.setItem("be:notesRapidCheck", "true");
    } catch {
      /* private mode */
    }
  });
  const peer = await newUserContext(browser, "rapid-bulk-peer");
  openContexts.push(peer.context);
  const peerApi = authedRequest(peer.context.request, peer.auth.token, peer.auth.csrf);

  // The last verse with 2+ live notes: the first test works on the first
  // verse with 4+, so the two stay apart.
  const chap = await fetchChapter(context.request, auth.token, BOOK, CHAPTER);
  const live = (chap.tn as Row[]).filter((r) => r.trashed_at == null && r.verse > 0);
  const byVerse = new Map<number, Row[]>();
  for (const r of live) byVerse.set(r.verse, [...(byVerse.get(r.verse) ?? []), r]);
  const verse = [...byVerse.keys()].sort((a, b) => b - a).find((v) => byVerse.get(v)!.length >= 2);
  expect(verse, `ZEC ${CHAPTER} needs a verse with 2+ notes`).toBeDefined();

  const page = await context.newPage();
  const list = await openRapid(page, verse!, byVerse.get(verse!)![0].id);
  const ids = (await list.locator("[data-rapid-row]").evaluateAll((els) => els.map((el) => el.getAttribute("data-rapid-row")))) as string[];
  const [kept, edited] = ids;
  const shown = (await serverRows(context, auth.token)).get(edited)!;
  // Make `edited` the open note: its text in the list is the editor's value,
  // which only a reload re-seeds (#837 review), so the end check below sees
  // whether the open note really shows the peer's text.
  await list.locator(`[data-rapid-select="${edited}"]`).click();
  await expect(list.locator('[data-rapid-row][aria-current="true"]')).toHaveAttribute("data-rapid-row", edited);

  // The peer edits `edited` the moment its trash request leaves the browser.
  let sentIfMatch: string | undefined;
  let sentBody: unknown;
  await page.route(`**/api/rows/tn/${edited}/trash*`, async (route) => {
    sentIfMatch = route.request().headers()["if-match"];
    sentBody = route.request().postDataJSON();
    const res = await peerApi.patch(`/api/rows/tn/${edited}?book=${BOOK}`, { note: `${shown.note} peer edit` }, shown.version);
    expect(res.status(), "peer PATCH").toBe(200);
    await route.continue();
  });

  await list.locator(`[data-rapid-checkbox="${kept}"]`).click();
  await list.locator(`[data-rapid-checkbox="${edited}"]`).click({ modifiers: ["Shift"] });
  const bar = page.locator("[data-rapid-bulk-bar]");
  await expect(bar).toContainText("Checked: 2");
  await bar.getByRole("button", { name: "Not needed", exact: true }).click();

  const result = page.locator("[data-rapid-bulk-result]");
  await expect(result).toContainText("Marked not needed: 1. Skipped: 1 (changed by someone else, reloaded: 1).", {
    timeout: 20_000,
  });
  expect(sentIfMatch, "the trash request carried the version on screen").toBe(String(shown.version));
  expect(sentBody, "and the state on screen").toEqual({ expected_state: shown.translation_state });
  const server = await serverRows(context, auth.token);
  expect(server.get(kept)?.trashed_at, "the untouched note was set aside").not.toBeNull();
  expect(server.get(edited)?.trashed_at, "the peer-edited note was not set aside").toBeNull();
  expect(server.get(edited)?.note).toBe(`${shown.note} peer edit`);
  // The open note was reloaded: it shows the peer's text, not the old text.
  await expect(list.locator(`[data-rapid-row="${edited}"]`)).toContainText("peer edit", { timeout: 20_000 });
  // The skipped note stays checked, so a second press acts on it once seen.
  await expect(bar).toContainText("Checked: 1");
  await expect(list.locator(`[data-rapid-checkbox="${edited}"]`)).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: test.info().outputPath("rapid-bulk-pin-1366x768.png") });

  // Leave the chapter as found: Undo brings the set-aside note back, and the
  // peer puts the edited note's text back.
  await result.getByRole("button", { name: "Undo" }).click();
  await expect(result).toContainText("Restored: 1.", { timeout: 20_000 });
  const after = await serverRows(context, auth.token);
  expect(after.get(kept)?.trashed_at).toBeNull();
  await restoreNoteText(peerApi, edited, shown.note, after.get(edited)!.version);
  expect((await serverRows(context, auth.token)).get(edited)?.note).toBe(shown.note);
});

// #837, the single-note button: Not needed on the open note is pinned the same
// way. A colleague's edit that lands as the request leaves is refused, the
// changed-elsewhere notice shows, and the open note reloads with their text.
test("notes screen: single Not needed refuses a note a peer just edited and reloads it", async ({ browser }) => {
  const { context, auth } = await newUserContext(browser, "rapid-single-pin");
  openContexts.push(context);
  await context.addInitScript(() => {
    try {
      localStorage.setItem("be:notesRapidCheck", "true");
    } catch {
      /* private mode */
    }
  });
  const peer = await newUserContext(browser, "rapid-single-peer");
  openContexts.push(peer.context);
  const peerApi = authedRequest(peer.context.request, peer.auth.token, peer.auth.csrf);

  // A verse neither test above uses: not the first with 4+ notes, not the
  // last with 2+.
  const chap = await fetchChapter(context.request, auth.token, BOOK, CHAPTER);
  const live = (chap.tn as Row[]).filter((r) => r.trashed_at == null && r.verse > 0);
  const byVerse = new Map<number, Row[]>();
  for (const r of live) byVerse.set(r.verse, [...(byVerse.get(r.verse) ?? []), r]);
  const asc = [...byVerse.keys()].sort((a, b) => a - b);
  const taken = new Set([asc.find((v) => byVerse.get(v)!.length >= 4), [...asc].reverse().find((v) => byVerse.get(v)!.length >= 2)]);
  const verse = asc.find((v) => !taken.has(v));
  expect(verse, `ZEC ${CHAPTER} needs a third verse with notes`).toBeDefined();
  const target = byVerse.get(verse!)![0];

  const page = await context.newPage();
  const list = await openRapid(page, verse!, target.id);
  await expect(list.locator('[data-rapid-row][aria-current="true"]')).toHaveAttribute("data-rapid-row", target.id);

  let sentIfMatch: string | undefined;
  let sentBody: unknown;
  await page.route(`**/api/rows/tn/${target.id}/trash*`, async (route) => {
    sentIfMatch = route.request().headers()["if-match"];
    sentBody = route.request().postDataJSON();
    const res = await peerApi.patch(`/api/rows/tn/${target.id}?book=${BOOK}`, { note: `${target.note} single peer edit` }, target.version);
    expect(res.status(), "peer PATCH").toBe(200);
    await route.continue();
  });

  // No note is checked, so the only Not needed button is the open note's.
  await expect(page.locator("[data-rapid-bulk-bar]")).toHaveCount(0);
  await page.getByRole("button", { name: "Not needed", exact: true }).click();
  await expect(page.getByText("Someone changed this note since it was shown. It has been reloaded")).toBeVisible({
    timeout: 20_000,
  });
  expect(sentIfMatch, "the trash request carried the version on screen").toBe(String(target.version));
  expect(sentBody, "and the state on screen").toEqual({ expected_state: target.translation_state });
  const server = (await serverRows(context, auth.token)).get(target.id);
  expect(server?.trashed_at, "the peer-edited note was not set aside").toBeNull();
  expect(server?.note).toBe(`${target.note} single peer edit`);
  // The reload brings the colleague's text onto the open note.
  await expect(list.locator(`[data-rapid-row="${target.id}"]`)).toContainText("single peer edit", { timeout: 20_000 });
  await page.screenshot({ path: test.info().outputPath("rapid-single-pin-1366x768.png") });

  // Leave the chapter as found: the peer puts the note's text back.
  const now = (await serverRows(context, auth.token)).get(target.id)!;
  await restoreNoteText(peerApi, target.id, target.note, now.version);
  expect((await serverRows(context, auth.token)).get(target.id)?.note).toBe(target.note);
});

// #850: bulk Approve reloads the open note when it skips it as changed, as
// bulk Not needed does (#837). The open note's editor re-seeds only on a
// reload, so a plain refetch left it showing the old text while its version
// moved to the peer's edit. The peer PATCH runs inside the route handler for
// that note's validate request, so the 409 comes from the server's pin.
test("rapid check bulk: Approve reloads the open note a peer edited just before its approval", async ({ browser }) => {
  const { context, auth } = await newUserContext(browser, "rapid-bulk-approve-pin");
  openContexts.push(context);
  await context.addInitScript(() => {
    try {
      localStorage.setItem("be:notesRapidCheck", "true");
    } catch {
      /* private mode */
    }
  });
  const peer = await newUserContext(browser, "rapid-bulk-approve-peer");
  openContexts.push(peer.context);
  const peerApi = authedRequest(peer.context.request, peer.auth.token, peer.auth.csrf);

  // A verse with 2+ notes that none of the tests above uses: not the first
  // with 4+, not the last with 2+, not the single-button test's verse.
  const chap = await fetchChapter(context.request, auth.token, BOOK, CHAPTER);
  const live = (chap.tn as Row[]).filter((r) => r.trashed_at == null && r.verse > 0);
  const byVerse = new Map<number, Row[]>();
  for (const r of live) byVerse.set(r.verse, [...(byVerse.get(r.verse) ?? []), r]);
  const asc = [...byVerse.keys()].sort((a, b) => a - b);
  const taken = new Set([asc.find((v) => byVerse.get(v)!.length >= 4), [...asc].reverse().find((v) => byVerse.get(v)!.length >= 2)]);
  taken.add(asc.find((v) => !taken.has(v)));
  const verse = asc.find((v) => !taken.has(v) && byVerse.get(v)!.length >= 2);
  expect(verse, `ZEC ${CHAPTER} needs a fourth verse with 2+ notes`).toBeDefined();
  for (const r of byVerse.get(verse!)!) expect(r.translation_state, `seeded ai_draft for ${r.id}`).toBe("ai_draft");

  const page = await context.newPage();
  const list = await openRapid(page, verse!, byVerse.get(verse!)![0].id);
  const ids = (await list.locator("[data-rapid-row]").evaluateAll((els) => els.map((el) => el.getAttribute("data-rapid-row")))) as string[];
  const [kept, edited] = ids;
  const shown = (await serverRows(context, auth.token)).get(edited)!;
  // Make `edited` the open note, with no typing, so bulk Approve sends its
  // pinned validate request rather than Save & approve.
  await list.locator(`[data-rapid-select="${edited}"]`).click();
  await expect(list.locator('[data-rapid-row][aria-current="true"]')).toHaveAttribute("data-rapid-row", edited);

  // The peer edits `edited` the moment its validate request leaves the browser.
  let sentIfMatch: string | undefined;
  await page.route(`**/api/rows/tn/${edited}/validate*`, async (route) => {
    sentIfMatch = route.request().headers()["if-match"];
    const res = await peerApi.patch(`/api/rows/tn/${edited}?book=${BOOK}`, { note: `${shown.note} approve peer edit` }, shown.version);
    expect(res.status(), "peer PATCH").toBe(200);
    await route.continue();
  });

  await list.locator(`[data-rapid-checkbox="${kept}"]`).click();
  await list.locator(`[data-rapid-checkbox="${edited}"]`).click({ modifiers: ["Shift"] });
  const bar = page.locator("[data-rapid-bulk-bar]");
  await expect(bar).toContainText("Checked: 2");
  await bar.getByRole("button", { name: "Approve", exact: true }).click();

  const result = page.locator("[data-rapid-bulk-result]");
  await expect(result).toContainText("Approved: 1. Skipped: 1 (changed by someone else, reloaded: 1).", { timeout: 20_000 });
  expect(sentIfMatch, "the validate request carried the version on screen").toBe(String(shown.version));
  const server = await serverRows(context, auth.token);
  expect(server.get(kept)?.translation_state, "the untouched note was approved").toBe("validated");
  expect(server.get(edited)?.translation_state, "the peer-edited note was not approved").not.toBe("validated");
  expect(server.get(edited)?.note).toBe(`${shown.note} approve peer edit`);
  // The open note was reloaded: it shows the peer's text, not the old text.
  await expect(list.locator(`[data-rapid-row="${edited}"]`)).toContainText("approve peer edit", { timeout: 20_000 });
  // The skipped note stays checked, so a second press acts on it once seen.
  await expect(bar).toContainText("Checked: 1");
  await expect(list.locator(`[data-rapid-checkbox="${edited}"]`)).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: test.info().outputPath("rapid-bulk-approve-pin-1366x768.png") });

  // Leave the chapter's text as found: the peer puts the edited note's text
  // back. Approve has no Undo; global-setup reseeds ZEC 4 as AI drafts.
  await restoreNoteText(peerApi, edited, shown.note, server.get(edited)!.version);
  expect((await serverRows(context, auth.token)).get(edited)?.note).toBe(shown.note);
});

// #853: bulk Redo with AI reloads the open note when it skips it as changed,
// as bulk Not needed (#837) and bulk Approve (#850) do. Redo sends no version,
// so its last check is the chapter re-read (changedSinceShown); the peer PATCH
// runs inside the route handler for that read, so it lands after every check
// the browser made before. Only the open note is checked, so no AI job starts:
// a job that finished would reload the screen itself and hide the bug.
test("rapid check bulk: Redo with AI reloads the open note a peer edited just before the redo", async ({ browser }) => {
  const { context, auth } = await newUserContext(browser, "rapid-bulk-redo-pin");
  openContexts.push(context);
  await context.addInitScript(() => {
    try {
      localStorage.setItem("be:notesRapidCheck", "true");
    } catch {
      /* private mode */
    }
  });
  const peer = await newUserContext(browser, "rapid-bulk-redo-peer");
  openContexts.push(peer.context);
  const peerApi = authedRequest(peer.context.request, peer.auth.token, peer.auth.csrf);

  // A verse none of the tests above uses: not the first with 4+, not the last
  // with 2+, not the single-button test's verse, not the bulk Approve test's.
  const chap = await fetchChapter(context.request, auth.token, BOOK, CHAPTER);
  const live = (chap.tn as Row[]).filter((r) => r.trashed_at == null && r.verse > 0);
  const byVerse = new Map<number, Row[]>();
  for (const r of live) byVerse.set(r.verse, [...(byVerse.get(r.verse) ?? []), r]);
  const asc = [...byVerse.keys()].sort((a, b) => a - b);
  const taken = new Set([asc.find((v) => byVerse.get(v)!.length >= 4), [...asc].reverse().find((v) => byVerse.get(v)!.length >= 2)]);
  taken.add(asc.find((v) => !taken.has(v)));
  taken.add(asc.find((v) => !taken.has(v) && byVerse.get(v)!.length >= 2));
  const verse = asc.find((v) => !taken.has(v));
  expect(verse, `ZEC ${CHAPTER} needs a fifth verse with notes`).toBeDefined();
  const target = byVerse.get(verse!)![0];
  // Redo skips an approved note before it looks for a peer's edit.
  expect(target.translation_state, `seeded ai_draft for ${target.id}`).toBe("ai_draft");

  const page = await context.newPage();
  // Bulk Redo is offered only in a translation workspace; the seeded one is
  // authoring, so the screen is told it is translating.
  await page.route(
    "**/api/project-config",
    closeTolerant(page, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const res = await route.fetch();
      const body = await res.json();
      body.config = { ...body.config, mode: "translation" };
      return route.fulfill({ response: res, json: body });
    }),
  );
  // No AI provider is ever called: a start would mean the note was not skipped.
  let aiCalls = 0;
  await page.route(/\/api\/(pipelines\/start|tn-quick)/, (route) => {
    aiCalls++;
    return route.fulfill({ status: 503, json: { error: "stubbed in test" } });
  });
  // The peer edits the note the moment the redo's chapter re-read leaves the
  // browser. One-shot: the refetch after the run must not edit again.
  let armed = false;
  let peerEdited = false;
  await page.route(
    (url) => url.pathname === `/api/chapters/${BOOK}/${CHAPTER}`,
    closeTolerant(page, async (route) => {
      if (armed && route.request().method() === "GET") {
        armed = false;
        const res = await peerApi.patch(`/api/rows/tn/${target.id}?book=${BOOK}`, { note: `${target.note} redo peer edit` }, target.version);
        expect(res.status(), "peer PATCH").toBe(200);
        peerEdited = true;
      }
      return route.continue();
    }),
  );

  const list = await openRapid(page, verse!, target.id);
  await expect(list.locator('[data-rapid-row][aria-current="true"]')).toHaveAttribute("data-rapid-row", target.id);
  await list.locator(`[data-rapid-checkbox="${target.id}"]`).click();
  const bar = page.locator("[data-rapid-bulk-bar]");
  await expect(bar).toContainText("Checked: 1");
  const redoBtn = bar.getByRole("button", { name: "Redo with AI" });
  await expect(redoBtn).toBeEnabled();

  armed = true;
  await redoBtn.click();

  const result = page.locator("[data-rapid-bulk-result]");
  await expect(result).toContainText("Skipped: 1 (changed by someone else, reloaded: 1).", { timeout: 20_000 });
  expect(peerEdited, "the peer edit ran inside the redo's chapter re-read").toBe(true);
  expect(aiCalls, "no AI job was started").toBe(0);
  const server = (await serverRows(context, auth.token)).get(target.id)!;
  expect(server.note).toBe(`${target.note} redo peer edit`);
  // The open note was reloaded: it shows the peer's text, not the old text.
  await expect(list.locator(`[data-rapid-row="${target.id}"]`)).toContainText("redo peer edit", { timeout: 20_000 });
  // The skipped note stays checked, so a second press acts on it once seen.
  await expect(bar).toContainText("Checked: 1");
  await expect(list.locator(`[data-rapid-checkbox="${target.id}"]`)).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: test.info().outputPath("rapid-bulk-redo-pin-1366x768.png") });

  // Leave the chapter's text as found: the peer puts the note's text back.
  await restoreNoteText(peerApi, target.id, target.note, server.version);
  expect((await serverRows(context, auth.token)).get(target.id)?.note).toBe(target.note);
});
