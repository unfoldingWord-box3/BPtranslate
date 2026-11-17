import { expect, test, request as apiRequest, type BrowserContext, type Page } from "@playwright/test";
import { authedRequest, closeTolerant, fetchChapter, gotoVerse, mintToken, newUserContext, noteTextarea } from "./helpers";
import { ZEC_CHAPTERS } from "./chapters";

// Honor BE_BASE_URL so the suite runs on a relocated port (mirrors s8).
const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";

// Issue #892. When Alice's save of a note is refused because Bob saved the
// same note first, the classic editor shows both versions on the note itself
// and lets her keep hers (re-sent at Bob's version) or keep his (her queued
// saves of the row are dropped and his text goes in the editor, with no
// unsaved draft left behind).
//
// The conflict is made deterministic: Alice's first PATCH is held in
// context.route until Bob's API write has landed, then sent on to the real
// server, which answers 409 version_mismatch with Bob's row. A WebSocket push
// of Bob's write before Alice saves would otherwise let her save land on top.
// ZEC 8 is shared with refused-save-keeps-text, which only visits it; each
// case here edits its own row, and globalSetup re-imports ZEC each run.
const CHAPTER = ZEC_CHAPTERS.keepsTextAway.chapter;

interface Row {
  id: string;
  verse: number;
  version: number;
  note?: string | null;
  question?: string | null;
}

async function serverRows(kind: "tn" | "tq"): Promise<Row[]> {
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const auth = await mintToken(probe, "probe-892");
  const chapter = await fetchChapter(probe, auth.token, "ZEC", CHAPTER);
  await probe.dispose();
  return (kind === "tn" ? chapter.tn : chapter.tq) as unknown as Row[];
}

// Each case takes its own row so the cases never edit the same one.
async function pickRow(kind: "tn" | "tq", index: number): Promise<Row> {
  const rows = (await serverRows(kind)).filter((r) => r.verse > 1);
  expect(rows.length, `expected ${index + 1}+ ${kind} rows after verse 1 on ZEC ${CHAPTER}`).toBeGreaterThan(index);
  return rows[index];
}

async function serverRow(kind: "tn" | "tq", id: string): Promise<Row | undefined> {
  return (await serverRows(kind)).find((r) => r.id === id);
}

/** Bob saves `patch` straight to the server at the row's current version. */
async function bobSaves(kind: "tn" | "tq", id: string, patch: Record<string, string>) {
  const ctx = await apiRequest.newContext({ baseURL: BASE });
  const bob = await mintToken(ctx, "bob-892");
  const current = await serverRow(kind, id);
  const res = await authedRequest(ctx, bob.token, bob.csrf).patch(
    `/api/rows/${kind}/${id}?book=ZEC`,
    patch,
    current!.version,
  );
  expect(res.status(), "Bob's save should land").toBe(200);
  const body = (await res.json()) as Row;
  await ctx.dispose();
  return body;
}

/**
 * Hold the first PATCH of the row until `release()`, then send it on to the
 * server. Later PATCHes go straight through. `count()` is how many were sent.
 */
async function holdFirstPatch(context: BrowserContext, page: Page, kind: "tn" | "tq", id: string) {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let sent = 0;
  await context.route(
    `**/api/rows/${kind}/${id}**`,
    closeTolerant(page, async (route, request) => {
      if (request.method() !== "PATCH") return route.continue();
      sent++;
      if (sent === 1) await held;
      await route.continue();
    }),
  );
  return { release, count: () => sent };
}

// Ops queued for the row in IndexedDB, across every "bible-editor-outbox*" database.
function queuedOps(page: Page, id: string) {
  return page.evaluate(async (rowId) => {
    const out: Array<{ status: string; patch: Record<string, unknown> }> = [];
    const dbs = (await indexedDB.databases()).filter((d) => (d.name ?? "").startsWith("bible-editor-outbox"));
    for (const meta of dbs) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(meta.name!, meta.version);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        if (!db.objectStoreNames.contains("ops")) continue;
        const all = await new Promise<Array<{ target: { id?: string }; status: string; patch: Record<string, unknown> }>>(
          (resolve, reject) => {
            const req = db.transaction("ops", "readonly").objectStore("ops").getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          },
        );
        for (const o of all) if (o.target.id === rowId) out.push({ status: o.status, patch: o.patch });
      } finally {
        db.close();
      }
    }
    return out;
  }, id);
}

// The row draft's patch (null when there is none), across every drafts database.
function draftPatch(page: Page, key: string) {
  return page.evaluate(async (k) => {
    const dbs = (await indexedDB.databases()).filter((d) => (d.name ?? "").startsWith("bible-editor-drafts"));
    for (const meta of dbs) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(meta.name!, meta.version);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        if (!db.objectStoreNames.contains("drafts")) continue;
        const rec = await new Promise<{ payload?: { patch?: Record<string, unknown> } } | undefined>((resolve, reject) => {
          const req = db.transaction("drafts", "readonly").objectStore("drafts").get(k);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        if (rec) return rec.payload?.patch ?? {};
      } finally {
        db.close();
      }
    }
    return null;
  }, key);
}

function noteCard(page: Page, id: string) {
  return page.locator(`[data-note-id="${id}"]`);
}

function notePanel(page: Page, id: string) {
  return noteCard(page, id).locator('[data-row-conflict="true"]');
}

function saveButton(page: Page, id: string) {
  return noteCard(page, id).locator('button:has([data-testid="SaveIcon"])');
}

async function expectNoUnsaved(page: Page) {
  // Give the drafts store a moment to settle before asserting an absence.
  await page.waitForTimeout(1_000);
  await expect(page.getByText(/^\d+ unsaved$/)).toHaveCount(0);
}

/** Alice saves `alice` on the note while Bob saves `bob` first: her save comes back 409. */
async function makeNoteConflict(page: Page, context: BrowserContext, row: Row, alice: string, bob: string) {
  const hold = await holdFirstPatch(context, page, "tn", row.id);
  await gotoVerse(page, "ZEC", CHAPTER, row.verse);
  await noteTextarea(page, row.id).fill(alice);
  await saveButton(page, row.id).click();
  await expect.poll(hold.count, { message: "Alice's PATCH should reach the route" }).toBe(1);
  const bobRow = await bobSaves("tn", row.id, { note: bob });
  hold.release();
  await expect(notePanel(page, row.id)).toBeVisible({ timeout: 15_000 });
  return bobRow;
}

test("tN card: a refused save shows both versions; Keep theirs puts Bob's note back for good", async ({ browser }) => {
  test.setTimeout(90_000);
  const row = await pickRow("tn", 0);
  const { context } = await newUserContext(browser, "alice-892-theirs");
  const page = await context.newPage();
  const alice = `ALICE theirs ${Date.now()}`;
  const bob = `BOB theirs ${Date.now()}`;
  await makeNoteConflict(page, context, row, alice, bob);

  // (a) Both versions, side by side, on the note.
  const panel = notePanel(page, row.id);
  await expect(panel).toContainText(alice);
  await expect(panel).toContainText(bob);
  await expect(panel.getByRole("button", { name: "Keep mine" })).toBeEnabled();

  // (b) Keep theirs.
  await panel.getByRole("button", { name: "Keep theirs" }).click();
  await expect(panel).toHaveCount(0);
  await expect(noteTextarea(page, row.id)).toHaveValue(bob);
  await expect.poll(() => queuedOps(page, row.id).then((o) => o.length)).toBe(0);
  await expect.poll(() => draftPatch(page, `row:tn:ZEC:${row.id}`)).toBeNull();
  await expectNoUnsaved(page);
  expect((await serverRow("tn", row.id))?.note).toBe(bob);

  await page.reload();
  await noteCard(page, row.id).waitFor();
  await expect(noteTextarea(page, row.id)).toHaveValue(bob);
  await expect(notePanel(page, row.id)).toHaveCount(0);
  await expectNoUnsaved(page);
  expect((await serverRow("tn", row.id))?.note).toBe(bob);
  await context.close();
});

test("tN card: typing after the refused save shows under Mine, and Keep theirs replaces it", async ({ browser }) => {
  test.setTimeout(90_000);
  const row = await pickRow("tn", 3);
  const { context } = await newUserContext(browser, "alice-892-typing");
  const page = await context.newPage();
  const alice = `ALICE typing ${Date.now()}`;
  const bob = `BOB typing ${Date.now()}`;
  await makeNoteConflict(page, context, row, alice, bob);

  // Review K1: Mine is what Keep theirs throws away, unsaved typing included.
  const more = `${alice} and more typed after the refusal`;
  await noteTextarea(page, row.id).fill(more);
  const panel = notePanel(page, row.id);
  await expect(panel).toContainText(more);
  await expect(panel).toContainText(bob);

  await panel.getByRole("button", { name: "Keep theirs" }).click();
  await expect(panel).toHaveCount(0);
  await expect(noteTextarea(page, row.id)).toHaveValue(bob);
  await expect.poll(() => draftPatch(page, `row:tn:ZEC:${row.id}`)).toBeNull();
  await expectNoUnsaved(page);
  expect((await serverRow("tn", row.id))?.note).toBe(bob);
  await context.close();
});

// Review L1: a third writer. Alice's save is refused on Bob's V2; Carol then
// saves V3. Keep theirs must end on Carol's text, clean, and never send Bob's
// older text back over hers.
for (const cacheHasV3 of [false, true]) {
  test(`tN card: Keep theirs after a third save ends on the newest text (${
    cacheHasV3 ? "cache already holds it" : "live updates blocked"
  })`, async ({ browser }) => {
    test.setTimeout(90_000);
    const row = await pickRow("tn", cacheHasV3 ? 5 : 4);
    const { context } = await newUserContext(browser, `alice-892-third-${cacheHasV3}`);
    // With live updates blocked, Carol's save reaches Alice's cache only
    // through the re-read Keep theirs triggers (rowRebuild).
    if (!cacheHasV3) await context.routeWebSocket((url) => url.protocol.startsWith("ws"), () => {});
    const page = await context.newPage();
    const alice = `ALICE third ${Date.now()}`;
    const bob = `BOB third ${Date.now()}`;
    const carol = `CAROL third ${Date.now()}`;
    await makeNoteConflict(page, context, row, alice, bob);
    const carolRow = await bobSaves("tn", row.id, { note: carol });
    if (cacheHasV3) {
      // The version chip shows the cached row's version once Carol's save arrives.
      await expect(noteCard(page, row.id)).toContainText(`v${carolRow.version}`, { timeout: 15_000 });
    }

    await notePanel(page, row.id).getByRole("button", { name: "Keep theirs" }).click();
    await expect(notePanel(page, row.id)).toHaveCount(0);
    await expect(noteTextarea(page, row.id)).toHaveValue(carol, { timeout: 15_000 });
    await expect.poll(() => queuedOps(page, row.id).then((o) => o.length)).toBe(0);
    await expect.poll(() => draftPatch(page, `row:tn:ZEC:${row.id}`)).toBeNull();
    await expectNoUnsaved(page);
    await expect(saveButton(page, row.id)).toHaveCount(0);
    await page.waitForTimeout(2_000);
    const server = await serverRow("tn", row.id);
    expect(server?.note).toBe(carol);
    expect(server?.version).toBe(carolRow.version);
    await context.close();
  });
}

// Review R1: Bob's V2 reaches Alice's cache by live update, then Alice types
// more, in the quote too, which the card writes into the cached row at V2.
// Keep theirs must load Bob's row from the 409, not that cached copy.
test("tN card: Keep theirs ignores Alice's typing that sits in the cached row", async ({ browser }) => {
  test.setTimeout(90_000);
  const row = await pickRow("tn", 6);
  const before = await serverRow("tn", row.id);
  const { context } = await newUserContext(browser, "alice-892-r1");
  const page = await context.newPage();
  const alice = `ALICE r1 ${Date.now()}`;
  const bob = `BOB r1 ${Date.now()}`;
  const bobRow = await makeNoteConflict(page, context, row, alice, bob);
  // The version chip shows Bob's version once his save reaches the cache.
  await expect(noteCard(page, row.id)).toContainText(`v${bobRow.version}`, { timeout: 15_000 });

  const quoteField = noteCard(page, row.id).locator('textarea:not([aria-hidden="true"])').first();
  const originalQuote = await quoteField.inputValue();
  await quoteField.fill(`${originalQuote} ALICE QUOTE`);
  await noteTextarea(page, row.id).fill(`${alice} and more`);
  // The quote reaches the cached row after a short debounce.
  await page.waitForTimeout(600);

  await notePanel(page, row.id).getByRole("button", { name: "Keep theirs" }).click();
  await expect(notePanel(page, row.id)).toHaveCount(0);
  await expect(noteTextarea(page, row.id)).toHaveValue(bob);
  await expect(quoteField).toHaveValue(originalQuote);
  await expect.poll(() => queuedOps(page, row.id).then((o) => o.length)).toBe(0);
  await expect.poll(() => draftPatch(page, `row:tn:ZEC:${row.id}`)).toBeNull();
  await expectNoUnsaved(page);
  await expect(saveButton(page, row.id)).toHaveCount(0);
  await page.waitForTimeout(2_000);
  const server = await serverRow("tn", row.id);
  expect(server?.note).toBe(bob);
  expect(server?.version).toBe(bobRow.version);
  expect((server as { quote?: string | null })?.quote ?? null).toBe(
    (before as { quote?: string | null })?.quote ?? null,
  );
  await context.close();
});

// Review M1: Keep mine saves what Mine shows, typing after the refusal included.
test("tN card: Keep mine saves the typing made after the refused save too", async ({ browser }) => {
  test.setTimeout(90_000);
  const row = await pickRow("tn", 7);
  const { context } = await newUserContext(browser, "alice-892-m1");
  const page = await context.newPage();
  const alice = `ALICE m1 ${Date.now()}`;
  const bob = `BOB m1 ${Date.now()}`;
  await makeNoteConflict(page, context, row, alice, bob);
  const full = `${alice} and more typed after the refusal`;
  await noteTextarea(page, row.id).fill(full);
  await expect(notePanel(page, row.id)).toContainText(full);

  await notePanel(page, row.id).getByRole("button", { name: "Keep mine" }).click();
  await expect(notePanel(page, row.id)).toHaveCount(0);
  await expect.poll(() => serverRow("tn", row.id).then((r) => r?.note), { timeout: 15_000 }).toBe(full);
  await expect(noteTextarea(page, row.id)).toHaveValue(full);
  await expect.poll(() => queuedOps(page, row.id).then((o) => o.length)).toBe(0);
  await expect.poll(() => draftPatch(page, `row:tn:ZEC:${row.id}`)).toBeNull();
  await expectNoUnsaved(page);
  await expect(saveButton(page, row.id)).toHaveCount(0);
  await context.close();
});

test("tN card: Keep mine re-sends Alice's note over Bob's at the newer version", async ({ browser }) => {
  test.setTimeout(90_000);
  const row = await pickRow("tn", 1);
  const { context } = await newUserContext(browser, "alice-892-mine");
  const page = await context.newPage();
  const alice = `ALICE mine ${Date.now()}`;
  const bob = `BOB mine ${Date.now()}`;
  const bobRow = await makeNoteConflict(page, context, row, alice, bob);

  await notePanel(page, row.id).getByRole("button", { name: "Keep mine" }).click();
  await expect(notePanel(page, row.id)).toHaveCount(0);
  await expect.poll(() => serverRow("tn", row.id).then((r) => r?.note)).toBe(alice);
  expect((await serverRow("tn", row.id))?.version).toBe(bobRow.version + 1);
  await expect(noteTextarea(page, row.id)).toHaveValue(alice);
  await expect.poll(() => queuedOps(page, row.id).then((o) => o.length)).toBe(0);
  await context.close();
});

test("tN card: the compare comes back after a reload, and Keep theirs drops saves queued behind the conflict", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const row = await pickRow("tn", 2);
  const { context } = await newUserContext(browser, "alice-892-reload");
  const page = await context.newPage();
  const alice = `ALICE reload ${Date.now()}`;
  const bob = `BOB reload ${Date.now()}`;
  await makeNoteConflict(page, context, row, alice, bob);

  // (d) The conflict is kept in IndexedDB, so a reload shows the compare again.
  await page.reload();
  await noteCard(page, row.id).waitFor();
  await expect(notePanel(page, row.id)).toBeVisible({ timeout: 15_000 });
  await expect(notePanel(page, row.id)).toContainText(bob);

  // (e) Two more saves wait behind the conflict. The card's Save gate opens
  // only if the live update of Bob's write moves the row's version; each save
  // is made after a reload so the case does not depend on that push.
  const later = [`ALICE later one ${Date.now()}`, `ALICE later two ${Date.now()}`];
  for (const text of later) {
    await noteTextarea(page, row.id).fill(text);
    await saveButton(page, row.id).click();
    await expect
      .poll(() => queuedOps(page, row.id).then((o) => o.some((op) => op.patch.note === text)))
      .toBe(true);
    await page.reload();
    await noteCard(page, row.id).waitFor();
  }
  expect((await queuedOps(page, row.id)).length).toBe(3);
  // Mine is what Keep mine would save: the last queued text.
  await expect(notePanel(page, row.id)).toContainText(later[1]);

  await notePanel(page, row.id).getByRole("button", { name: "Keep theirs" }).click();
  await expect(notePanel(page, row.id)).toHaveCount(0);
  await expect(noteTextarea(page, row.id)).toHaveValue(bob);
  await expect.poll(() => queuedOps(page, row.id).then((o) => o.length)).toBe(0);
  // Nothing queued lands later on top of Bob's note.
  await page.waitForTimeout(3_000);
  expect((await serverRow("tn", row.id))?.note).toBe(bob);
  await page.reload();
  await noteCard(page, row.id).waitFor();
  await expect(noteTextarea(page, row.id)).toHaveValue(bob);
  await expectNoUnsaved(page);
  await context.close();
});

test("tQ table: Keep theirs puts Bob's question back for good", async ({ browser }) => {
  test.setTimeout(90_000);
  const row = await pickRow("tq", 0);
  const { context } = await newUserContext(browser, "alice-892-tq");
  const page = await context.newPage();
  const alice = `ALICE question ${Date.now()}`;
  const bob = `BOB question ${Date.now()}`;
  const questionRow = page.locator(`[data-question-id="${row.id}"]`);
  const questionField = questionRow.locator('textarea:not([aria-hidden="true"])').first();
  const panel = questionRow.locator('[data-row-conflict="true"]');

  const hold = await holdFirstPatch(context, page, "tq", row.id);
  await gotoVerse(page, "ZEC", CHAPTER, row.verse);
  await page.getByRole("button", { name: /^Questions/ }).click();
  await questionField.fill(alice);
  await questionRow.locator('button:has([data-testid="SaveIcon"])').click();
  await expect.poll(hold.count, { message: "Alice's PATCH should reach the route" }).toBe(1);
  await bobSaves("tq", row.id, { question: bob });
  hold.release();

  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toContainText(alice);
  await expect(panel).toContainText(bob);
  await panel.getByRole("button", { name: "Keep theirs" }).click();
  await expect(panel).toHaveCount(0);
  await expect(questionField).toHaveValue(bob);
  await expect.poll(() => queuedOps(page, row.id).then((o) => o.length)).toBe(0);
  await expect.poll(() => draftPatch(page, `row:tq:ZEC:${row.id}`)).toBeNull();
  await expectNoUnsaved(page);
  expect((await serverRow("tq", row.id))?.question).toBe(bob);

  // Review K4: the row is clean after Keep theirs, and a new edit saves.
  const saveIcon = questionRow.locator('button:has([data-testid="SaveIcon"])');
  await expect(saveIcon).toHaveCount(0);
  const after = `ALICE after keep theirs ${Date.now()}`;
  await questionField.fill(after);
  await saveIcon.click();
  await expect.poll(() => serverRow("tq", row.id).then((r) => r?.question)).toBe(after);
  await expect.poll(() => queuedOps(page, row.id).then((o) => o.length)).toBe(0);
  await expect(panel).toHaveCount(0);

  await page.reload();
  await page.getByRole("button", { name: /^Questions/ }).click();
  await expect(questionField).toHaveValue(after);
  await expect(panel).toHaveCount(0);
  await expectNoUnsaved(page);
  await context.close();
});

test("tQ table: Keep theirs after a third save ends on the newest question (live updates blocked)", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const row = await pickRow("tq", 1);
  const { context } = await newUserContext(browser, "alice-892-tq-third");
  await context.routeWebSocket((url) => url.protocol.startsWith("ws"), () => {});
  const page = await context.newPage();
  const alice = `ALICE q third ${Date.now()}`;
  const bob = `BOB q third ${Date.now()}`;
  const carol = `CAROL q third ${Date.now()}`;
  const questionRow = page.locator(`[data-question-id="${row.id}"]`);
  const questionField = questionRow.locator('textarea:not([aria-hidden="true"])').first();
  const panel = questionRow.locator('[data-row-conflict="true"]');

  const hold = await holdFirstPatch(context, page, "tq", row.id);
  await gotoVerse(page, "ZEC", CHAPTER, row.verse);
  await page.getByRole("button", { name: /^Questions/ }).click();
  await questionField.fill(alice);
  await questionRow.locator('button:has([data-testid="SaveIcon"])').click();
  await expect.poll(hold.count, { message: "Alice's PATCH should reach the route" }).toBe(1);
  await bobSaves("tq", row.id, { question: bob });
  hold.release();
  await expect(panel).toBeVisible({ timeout: 15_000 });
  const carolRow = await bobSaves("tq", row.id, { question: carol });

  await panel.getByRole("button", { name: "Keep theirs" }).click();
  await expect(panel).toHaveCount(0);
  await expect(questionField).toHaveValue(carol, { timeout: 15_000 });
  await expect(questionRow.locator('button:has([data-testid="SaveIcon"])')).toHaveCount(0);
  await expect.poll(() => draftPatch(page, `row:tq:ZEC:${row.id}`)).toBeNull();
  await expectNoUnsaved(page);
  await page.waitForTimeout(2_000);
  const server = await serverRow("tq", row.id);
  expect(server?.question).toBe(carol);
  expect(server?.version).toBe(carolRow.version);
  await context.close();
});
