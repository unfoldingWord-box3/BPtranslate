import { expect, test, request as apiRequest, type Page } from "@playwright/test";
import { authedRequest, fetchChapter, gotoVerse, mintToken, newUserContext, noteTextarea, saveNote } from "./helpers";
import { ZEC_CHAPTERS } from "./chapters";

// Honor BE_BASE_URL so the suite runs on a relocated port (mirrors s8).
const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";

// Issue #754. A tN draft restored on mount (a refused save kept as a draft by
// #724, or plain unsaved typing) was diffed against the note as it stood when
// the translator typed it. If another person saves that note before the
// translator comes back, a Save of the restored text must not replace the
// other person's note without a conflict prompt: it has to go out at the
// draft's version (If-Match), so the server answers 409 and the outbox holds a
// conflict. Before the fix the card rebased to the current row and sent the
// current version, and the server took it with a 200.
//
// The chapter is shared with rows-fast-typing, which never writes to the
// server (see chapters.ts); globalSetup re-imports ZEC each run. Not an
// ai_draft-seeded chapter: the classic Editor mode shows those notes read-only.
const CHAPTER = ZEC_CHAPTERS.rowsFastTyping.chapter;
const AWAY_CHAPTER = ZEC_CHAPTERS.reenablesSave.chapter;

interface DraftRecord {
  expectedVersion?: number;
  payload?: { patch?: Record<string, unknown>; baseline?: Record<string, unknown> };
}

// The row draft as stored in IndexedDB, searched across every
// "bible-editor-drafts*" database (the name carries a workspace suffix).
function readDraft(page: Page, key: string) {
  return page.evaluate(async (k) => {
    try {
      const dbs = (await indexedDB.databases()).filter((d) => (d.name ?? "").startsWith("bible-editor-drafts"));
      for (const meta of dbs) {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open(meta.name!, meta.version);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        try {
          if (!db.objectStoreNames.contains("drafts")) continue;
          const rec = await new Promise<unknown>((resolve, reject) => {
            const req = db.transaction("drafts", "readonly").objectStore("drafts").get(k);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          if (rec) return rec;
        } finally {
          db.close();
        }
      }
      return null;
    } catch {
      return null;
    }
  }, key) as Promise<DraftRecord | null>;
}

const variants = [
  {
    name: 'a save refused with a "locked" 409, the other save landing while the card is on screen',
    refused: true,
    away: false,
  },
  {
    name: 'a save refused with a "locked" 409, the other save landing while the translator is away',
    refused: true,
    away: true,
  },
  {
    name: "unsaved typing (never saved), the other save landing while the translator is away",
    refused: false,
    away: true,
  },
];

for (const [i, variant] of variants.entries()) {
  test(`tN card: a restored draft (${variant.name}) saves into a conflict, not over the newer note`, async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const probe = await apiRequest.newContext({ baseURL: BASE });
    const other = await mintToken(probe, `other-754-${i}`);
    const chapter = await fetchChapter(probe, other.token, "ZEC", CHAPTER);
    const byVerse = new Map<number, typeof chapter.tn>();
    for (const r of chapter.tn) byVerse.set(r.verse, [...(byVerse.get(r.verse) ?? []), r]);
    // One verse per variant (each test writes to its note), each with a
    // sibling note to move the focus to.
    const pairs = [...byVerse.entries()].filter(([v, rows]) => v > 1 && rows.length >= 2);
    expect(pairs.length, `expected ${variants.length} verses after 1 on ZEC ${CHAPTER} with two tN rows`).toBeGreaterThanOrEqual(
      variants.length,
    );
    const [tn, sibling] = pairs[i][1];
    const key = `row:tn:ZEC:${tn.id}`;
    const { context } = await newUserContext(browser, `restored-draft-754-${i}`);
    const page = await context.newPage();

    // The translator's PATCHes to this note: refused while `refuse` is set,
    // passed to the server (and recorded) after.
    let refuse = variant.refused;
    let refusedCount = 0;
    const sent: Array<{ ifMatch: string | undefined; body: Record<string, unknown>; status: number; response: string }> = [];
    await context.route(`**/api/rows/tn/${tn.id}**`, async (route, request) => {
      if (request.method() !== "PATCH") return route.continue();
      if (refuse) {
        refusedCount++;
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "chapter_locked", jobId: "job-754", pipelineType: "translate", startedAt: 1 }),
        });
      }
      const response = await route.fetch();
      const text = await response.text();
      sent.push({
        ifMatch: request.headers()["if-match"],
        body: (request.postDataJSON() ?? {}) as Record<string, unknown>,
        status: response.status(),
        response: text,
      });
      return route.fulfill({ response, body: text });
    });

    await gotoVerse(page, "ZEC", CHAPTER, tn.verse);
    const typed = `TRANSLATOR NOTE 754 ${i} ${Date.now()}`;
    await noteTextarea(page, tn.id).fill(typed);
    if (variant.refused) {
      await saveNote(page, tn.id);
      await expect.poll(() => refusedCount, { message: "the PATCH should reach the route" }).toBeGreaterThan(0);
    }
    await expect
      .poll(async () => (await readDraft(page, key))?.payload?.patch ?? null, { message: "the text should be in the drafts store" })
      .toEqual(expect.objectContaining({ note: typed }));
    const draftBefore = await readDraft(page, key);

    if (variant.away) {
      // Leave the chapter (a full navigation, so the card unmounts).
      await gotoVerse(page, "ZEC", AWAY_CHAPTER, 1);
    } else {
      // Close the card's session by focusing the sibling note, as in #724.
      await noteTextarea(page, sibling.id).click();
      await page.waitForTimeout(500);
    }

    // Another person saves the note: a newer version with new text.
    const otherText = `OTHER PERSON NOTE 754 ${i} ${Date.now()}`;
    const fresh = (await fetchChapter(probe, other.token, "ZEC", CHAPTER)).tn.find((r) => r.id === tn.id)!;
    const res = await authedRequest(probe, other.token, other.csrf).patch(
      `/api/rows/tn/${tn.id}?book=ZEC`,
      { note: otherText },
      fresh.version,
    );
    expect(res.status(), `second user's PATCH failed: ${await res.text()}`).toBe(200);
    const otherVersion = ((await res.json()) as { version: number }).version;

    if (!variant.away) {
      await expect(noteTextarea(page, tn.id)).toHaveValue(otherText, { timeout: 10_000 });
      await page.waitForTimeout(500);
    }
    const draftAfterOther = await readDraft(page, key);

    // Come back with a reload (page.goto to a hash-only change is a same-document
    // navigation), which restores the draft over the newer note.
    refuse = false;
    if (variant.away) await page.goto(`/#/ZEC/${CHAPTER}/${tn.verse}`);
    await page.reload();
    await page.locator("[data-note-id]").first().waitFor({ timeout: 10_000 });
    await expect(noteTextarea(page, tn.id)).toHaveValue(typed);
    await page.waitForTimeout(500);

    await saveNote(page, tn.id);
    await expect.poll(() => sent.length, { message: "the Save should reach the server" }).toBeGreaterThan(0);
    const save = sent[0];
    console.log(
      `[#754 ${variant.refused ? "refused" : "plain"}/${variant.away ? "away" : "on-screen"}]`,
      JSON.stringify({
        draftExpectedVersionBefore: draftBefore?.expectedVersion,
        draftExpectedVersionAfterOtherSave: draftAfterOther?.expectedVersion,
        draftBaselineNoteAfterOtherSave: draftAfterOther?.payload?.baseline?.note,
        startVersion: fresh.version,
        otherVersion,
        ifMatch: save.ifMatch,
        status: save.status,
        response: save.response.slice(0, 200),
      }),
    );

    // The Save goes out at the version the draft was typed against, the server
    // refuses it as stale, and the outbox holds a conflict for the translator.
    expect(save.ifMatch, "the restored draft's Save should carry the draft's version").toBe(String(fresh.version));
    expect(save.status, "the server should refuse the stale Save").toBe(409);
    await expect(page.getByText(/^1 conflict$/).first()).toBeVisible({ timeout: 10_000 });

    // The other person's note is still on the server, and no PATCH landed
    // (an auto-heal re-arm at the current version would show here as a 200).
    await page.waitForTimeout(1000);
    expect(
      sent.map((s) => `${s.ifMatch}:${s.status}`),
      "no Save of the restored draft should land",
    ).not.toContainEqual(expect.stringMatching(/:200$/));
    const after = (await fetchChapter(probe, other.token, "ZEC", CHAPTER)).tn.find((r) => r.id === tn.id)!;
    expect(after.note, "the other person's note must not be overwritten").toBe(otherText);
    expect(after.version).toBe(otherVersion);

    await probe.dispose();
    await context.close();
  });
}

test("tN card: text typed while the card's own save is pending saves cleanly after it lands", async ({ browser }) => {
  // The other side of #754: the copy a draft was typed against moves with the
  // translator's own save. Type, Save (held in flight), type more, let the
  // first save land, Save again: the second Save goes out at the landed
  // version and lands, with no conflict against the translator's own save.
  test.setTimeout(90_000);
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const auth = await mintToken(probe, "probe-754-own");
  const chapter = await fetchChapter(probe, auth.token, "ZEC", CHAPTER);
  const byVerse = new Map<number, typeof chapter.tn>();
  for (const r of chapter.tn) byVerse.set(r.verse, [...(byVerse.get(r.verse) ?? []), r]);
  // A verse after the ones the conflict cases use.
  const pairs = [...byVerse.entries()].filter(([v, rows]) => v > 1 && rows.length >= 2);
  expect(pairs.length).toBeGreaterThan(variants.length);
  const tn = pairs[variants.length][1][0];
  const { context } = await newUserContext(browser, "restored-draft-754-own");
  const page = await context.newPage();

  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const sent: Array<{ ifMatch: string | undefined; status: number }> = [];
  await context.route(`**/api/rows/tn/${tn.id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    if (sent.length === 0) await held;
    const response = await route.fetch();
    sent.push({ ifMatch: request.headers()["if-match"], status: response.status() });
    return route.fulfill({ response });
  });

  await gotoVerse(page, "ZEC", CHAPTER, tn.verse);
  const first = `OWN FIRST 754 ${Date.now()}`;
  await noteTextarea(page, tn.id).fill(first);
  await saveNote(page, tn.id);
  const second = `${first} AND MORE`;
  await noteTextarea(page, tn.id).fill(second);
  await page.waitForTimeout(500);
  release();
  await expect.poll(() => sent.length, { message: "the first save should land" }).toBe(1);
  expect(sent[0]).toEqual({ ifMatch: String(tn.version), status: 200 });

  await saveNote(page, tn.id);
  await expect.poll(() => sent.length, { message: "the second save should reach the server" }).toBe(2);
  expect(sent[1], "the second Save goes out at the landed version").toEqual({
    ifMatch: String(tn.version + 1),
    status: 200,
  });
  const after = (await fetchChapter(probe, auth.token, "ZEC", CHAPTER)).tn.find((r) => r.id === tn.id)!;
  expect(after.note).toBe(second);
  await expect(page.getByText(/^1 conflict$/)).toHaveCount(0);

  await probe.dispose();
  await context.close();
});

test("tN card: after resolving a restored draft's conflict (keep mine), more typing saves cleanly", async ({ browser }) => {
  // The classic status bar resolves a conflict by re-sending the edit at the
  // server's version (keep mine). Once it lands, the card's copy moves to the
  // landed row, so text typed after it saves at that version with no conflict.
  test.setTimeout(90_000);
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const other = await mintToken(probe, "other-754-resolve");
  const chapter = await fetchChapter(probe, other.token, "ZEC", CHAPTER);
  const byVerse = new Map<number, typeof chapter.tn>();
  for (const r of chapter.tn) byVerse.set(r.verse, [...(byVerse.get(r.verse) ?? []), r]);
  const used = new Set(
    [...byVerse.entries()]
      .filter(([v, rows]) => v > 1 && rows.length >= 2)
      .slice(0, variants.length + 1)
      .map(([v]) => v),
  );
  const tn = chapter.tn.find((r) => r.verse > 1 && !used.has(r.verse));
  expect(tn, `expected a tN row on ZEC ${CHAPTER} on a verse the other cases do not use`).toBeTruthy();
  const { context } = await newUserContext(browser, "restored-draft-754-resolve");
  const page = await context.newPage();

  const sent: Array<{ ifMatch: string | undefined; status: number }> = [];
  await context.route(`**/api/rows/tn/${tn!.id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    sent.push({ ifMatch: request.headers()["if-match"], status: response.status() });
    return route.fulfill({ response });
  });

  await gotoVerse(page, "ZEC", CHAPTER, tn!.verse);
  const typed = `RESOLVE MINE 754 ${Date.now()}`;
  await noteTextarea(page, tn!.id).fill(typed);
  await expect
    .poll(async () => (await readDraft(page, `row:tn:ZEC:${tn!.id}`))?.payload?.patch ?? null)
    .toEqual(expect.objectContaining({ note: typed }));
  await gotoVerse(page, "ZEC", AWAY_CHAPTER, 1);

  const res = await authedRequest(probe, other.token, other.csrf).patch(
    `/api/rows/tn/${tn!.id}?book=ZEC`,
    { note: `OTHER 754 RESOLVE ${Date.now()}` },
    tn!.version,
  );
  expect(res.status()).toBe(200);

  await page.goto(`/#/ZEC/${CHAPTER}/${tn!.verse}`);
  await page.reload();
  await page.locator("[data-note-id]").first().waitFor({ timeout: 10_000 });
  await expect(noteTextarea(page, tn!.id)).toHaveValue(typed);
  await page.waitForTimeout(500);
  await saveNote(page, tn!.id);
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ ifMatch: String(tn!.version), status: 409 });

  // Keep mine: re-sent at the server's version, and it lands.
  await page.getByText(/^1 conflict$/).first().click();
  await page.getByText(/^resolve 1 conflict$/).click();
  await expect.poll(() => sent.length, { message: "the re-sent save should reach the server" }).toBe(2);
  expect(sent[1]).toEqual({ ifMatch: String(tn!.version + 1), status: 200 });
  await page.keyboard.press("Escape");

  // More typing, Save: goes out at the landed version and lands.
  const more = `${typed} MORE`;
  await noteTextarea(page, tn!.id).fill(more);
  await saveNote(page, tn!.id);
  await expect.poll(() => sent.length, { message: "the next save should reach the server" }).toBe(3);
  expect(sent[2], "the next Save goes out at the landed version").toEqual({
    ifMatch: String(tn!.version + 2),
    status: 200,
  });
  const after = (await fetchChapter(probe, other.token, "ZEC", CHAPTER)).tn.find((r) => r.id === tn!.id)!;
  expect(after.note).toBe(more);

  await probe.dispose();
  await context.close();
});

test("tN card: a reorder of the note landing does not let a restored draft save over the newer note", async ({
  browser,
}) => {
  // Review A1 of #754: only the card's own Save moves the copy its text was
  // typed against. A reorder (sort_order) lands at a newer version that still
  // carries the other person's note; the restored draft's Save must still go
  // out at the old version and end in a conflict, not a 200.
  test.setTimeout(90_000);
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const other = await mintToken(probe, "other-754-reorder");
  const chapter = await fetchChapter(probe, other.token, "ZEC", CHAPTER);
  const byVerse = new Map<number, typeof chapter.tn>();
  for (const r of chapter.tn) byVerse.set(r.verse, [...(byVerse.get(r.verse) ?? []), r]);
  const pairs = [...byVerse.entries()].filter(([v, rows]) => v > 1 && rows.length >= 2);
  // Skip the verses the cases above use (the keep-mine case takes the first
  // tN verse after the first variants.length + 1 pair verses).
  const used = new Set(pairs.slice(0, variants.length + 1).map(([v]) => v));
  const keepMineVerse = chapter.tn.find((r) => r.verse > 1 && !used.has(r.verse))?.verse;
  const pair = pairs.find(([v]) => !used.has(v) && v !== keepMineVerse);
  expect(pair, `expected another verse on ZEC ${CHAPTER} with two tN rows`).toBeTruthy();
  const tn = pair![1][0];
  const key = `row:tn:ZEC:${tn.id}`;
  const { context } = await newUserContext(browser, "restored-draft-754-reorder");
  const page = await context.newPage();

  const sent: Array<{ ifMatch: string | undefined; body: Record<string, unknown>; status: number }> = [];
  await context.route(`**/api/rows/tn/${tn.id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    sent.push({
      ifMatch: request.headers()["if-match"],
      body: (request.postDataJSON() ?? {}) as Record<string, unknown>,
      status: response.status(),
    });
    return route.fulfill({ response });
  });

  await gotoVerse(page, "ZEC", CHAPTER, tn.verse);
  const typed = `REORDER 754 ${Date.now()}`;
  await noteTextarea(page, tn.id).fill(typed);
  await expect
    .poll(async () => (await readDraft(page, key))?.payload?.patch ?? null)
    .toEqual(expect.objectContaining({ note: typed }));
  await gotoVerse(page, "ZEC", AWAY_CHAPTER, 1);

  const otherText = `OTHER 754 REORDER ${Date.now()}`;
  const res = await authedRequest(probe, other.token, other.csrf).patch(
    `/api/rows/tn/${tn.id}?book=ZEC`,
    { note: otherText },
    tn.version,
  );
  expect(res.status()).toBe(200);

  await page.goto(`/#/ZEC/${CHAPTER}/${tn.verse}`);
  await page.reload();
  await page.locator("[data-note-id]").first().waitFor({ timeout: 10_000 });
  await expect(noteTextarea(page, tn.id)).toHaveValue(typed);
  await page.waitForTimeout(500);

  // Move the note within its verse: a sort_order patch of this row lands.
  const card = page.locator(`[data-note-id="${tn.id}"]`);
  const down = card.locator('[data-reorder-arrow="down"]');
  if (await down.isEnabled()) await down.click();
  else await card.locator('[data-reorder-arrow="up"]').click();
  await expect
    .poll(() => sent.some((s) => "sort_order" in s.body && s.status === 200), { message: "the reorder should land" })
    .toBe(true);
  await page.waitForTimeout(500);
  await expect(noteTextarea(page, tn.id)).toHaveValue(typed);

  await saveNote(page, tn.id);
  await expect.poll(() => sent.some((s) => "note" in s.body), { message: "the Save should reach the server" }).toBe(true);
  const save = sent.find((s) => "note" in s.body)!;
  console.log("[#754 reorder]", JSON.stringify({ sent: sent.map((s) => ({ ...s, body: Object.keys(s.body) })) }));
  expect(save.ifMatch, "the Save goes out at the version the draft was typed against").toBe(String(tn.version));
  expect(save.status).toBe(409);
  await expect(page.getByText(/^1 conflict$/).first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1000);
  expect(sent.filter((s) => "note" in s.body).map((s) => s.status)).not.toContain(200);
  const after = (await fetchChapter(probe, other.token, "ZEC", CHAPTER)).tn.find((r) => r.id === tn.id)!;
  expect(after.note, "the other person's note must not be overwritten").toBe(otherText);

  await probe.dispose();
  await context.close();
});

// Verses from the end of the chapter, clear of the ones the cases above take
// from the front: the last pair verse for the first case below, the one
// before it for the second.
async function pairFromEnd(probe: Parameters<typeof fetchChapter>[0], token: string, fromEnd: number) {
  const chapter = await fetchChapter(probe, token, "ZEC", CHAPTER);
  const byVerse = new Map<number, typeof chapter.tn>();
  for (const r of chapter.tn) byVerse.set(r.verse, [...(byVerse.get(r.verse) ?? []), r]);
  const pairs = [...byVerse.entries()].filter(([v, rows]) => v > 1 && rows.length >= 2);
  expect(pairs.length, `expected more pair verses on ZEC ${CHAPTER}`).toBeGreaterThan(variants.length + 3 + fromEnd);
  return pairs[pairs.length - 1 - fromEnd][1];
}

test("tN card: after the card's own save lands and no text is left unsaved, a later edit saves at the current version", async ({
  browser,
}) => {
  // Review round 3, C-F1. The card's own Save lands and nothing unsaved is
  // left, so the copy its text was typed against must be let go. Another
  // person then saves the note, the card shows their text, and the translator
  // edits that: the Save goes out at the current version and lands. Holding
  // on to the copy would send it at the old version and raise a false
  // conflict against a note the translator was looking at.
  test.setTimeout(90_000);
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const other = await mintToken(probe, "other-754-released");
  const [tn, sibling] = await pairFromEnd(probe, other.token, 0);
  const { context } = await newUserContext(browser, "restored-draft-754-released");
  const page = await context.newPage();

  const sent: Array<{ ifMatch: string | undefined; status: number }> = [];
  await context.route(`**/api/rows/tn/${tn.id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    sent.push({ ifMatch: request.headers()["if-match"], status: response.status() });
    return route.fulfill({ response });
  });

  await gotoVerse(page, "ZEC", CHAPTER, tn.verse);
  const mine = `OWN SAVE 754 RELEASED ${Date.now()}`;
  await noteTextarea(page, tn.id).fill(mine);
  await saveNote(page, tn.id);
  await expect.poll(() => sent.length, { message: "the own save should land" }).toBe(1);
  expect(sent[0]).toEqual({ ifMatch: String(tn.version), status: 200 });
  // Leave the card (it stays mounted) so it takes the next server copy.
  await noteTextarea(page, sibling.id).click();
  await page.waitForTimeout(1000);

  const otherText = `OTHER 754 RELEASED ${Date.now()}`;
  const res = await authedRequest(probe, other.token, other.csrf).patch(
    `/api/rows/tn/${tn.id}?book=ZEC`,
    { note: otherText },
    tn.version + 1,
  );
  expect(res.status(), `second user's PATCH failed: ${await res.text()}`).toBe(200);
  await expect(noteTextarea(page, tn.id)).toHaveValue(otherText, { timeout: 10_000 });
  await page.waitForTimeout(500);

  const edited = `${otherText} EDITED`;
  await noteTextarea(page, tn.id).fill(edited);
  await saveNote(page, tn.id);
  await expect.poll(() => sent.length, { message: "the edit's Save should reach the server" }).toBe(2);
  console.log("[#754 released]", JSON.stringify({ sent }));
  expect(sent[1], "the edit goes out at the current version and lands").toEqual({
    ifMatch: String(tn.version + 2),
    status: 200,
  });
  await expect(page.getByText(/^1 conflict$/)).toHaveCount(0);
  const after = (await fetchChapter(probe, other.token, "ZEC", CHAPTER)).tn.find((r) => r.id === tn.id)!;
  expect(after.note).toBe(edited);

  await probe.dispose();
  await context.close();
});

test("tN card: a restored draft's Save queued behind a reorder still goes out at the draft's version", async ({
  browser,
}) => {
  // Review round 3, C-F2. The restored draft's Save is queued while an
  // earlier write of the same row (a reorder) is still in flight. When the
  // reorder lands, the outbox must not move the Save up to the landed version:
  // that version carries the other person's note, and the Save would replace
  // it with a 200.
  test.setTimeout(90_000);
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const other = await mintToken(probe, "other-754-queued");
  const [tn] = await pairFromEnd(probe, other.token, 1);
  const key = `row:tn:ZEC:${tn.id}`;
  const { context } = await newUserContext(browser, "restored-draft-754-queued");
  const page = await context.newPage();

  let holdReorder = false;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const sent: Array<{ ifMatch: string | undefined; body: Record<string, unknown>; status: number }> = [];
  await context.route(`**/api/rows/tn/${tn.id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    if (holdReorder && "sort_order" in body) await held;
    const response = await route.fetch();
    sent.push({ ifMatch: request.headers()["if-match"], body, status: response.status() });
    return route.fulfill({ response });
  });

  await gotoVerse(page, "ZEC", CHAPTER, tn.verse);
  const typed = `QUEUED 754 ${Date.now()}`;
  await noteTextarea(page, tn.id).fill(typed);
  await expect
    .poll(async () => (await readDraft(page, key))?.payload?.patch ?? null)
    .toEqual(expect.objectContaining({ note: typed }));
  await gotoVerse(page, "ZEC", AWAY_CHAPTER, 1);

  const otherText = `OTHER 754 QUEUED ${Date.now()}`;
  const res = await authedRequest(probe, other.token, other.csrf).patch(
    `/api/rows/tn/${tn.id}?book=ZEC`,
    { note: otherText },
    tn.version,
  );
  expect(res.status()).toBe(200);

  await page.goto(`/#/ZEC/${CHAPTER}/${tn.verse}`);
  await page.reload();
  await page.locator("[data-note-id]").first().waitFor({ timeout: 10_000 });
  await expect(noteTextarea(page, tn.id)).toHaveValue(typed);
  await page.waitForTimeout(500);

  // Reorder the note and hold its PATCH in flight, then Save the draft.
  holdReorder = true;
  const card = page.locator(`[data-note-id="${tn.id}"]`);
  const down = card.locator('[data-reorder-arrow="down"]');
  if (await down.isEnabled()) await down.click();
  else await card.locator('[data-reorder-arrow="up"]').click();
  await page.waitForTimeout(500);
  await saveNote(page, tn.id);
  await page.waitForTimeout(500);
  release();

  await expect.poll(() => sent.some((s) => "note" in s.body), { message: "the Save should reach the server" }).toBe(true);
  await page.waitForTimeout(1000);
  console.log("[#754 queued]", JSON.stringify({ sent: sent.map((s) => ({ ...s, body: Object.keys(s.body) })) }));
  expect(sent.find((s) => "sort_order" in s.body)?.status, "the reorder should land").toBe(200);
  const save = sent.find((s) => "note" in s.body)!;
  expect(save.ifMatch, "the Save keeps the version the draft was typed against").toBe(String(tn.version));
  expect(save.status).toBe(409);
  await expect(page.getByText(/^1 conflict$/).first()).toBeVisible({ timeout: 10_000 });
  expect(sent.filter((s) => "note" in s.body).map((s) => s.status)).not.toContain(200);
  const after = (await fetchChapter(probe, other.token, "ZEC", CHAPTER)).tn.find((r) => r.id === tn.id)!;
  expect(after.note, "the other person's note must not be overwritten").toBe(otherText);

  await probe.dispose();
  await context.close();
});

// The quote field inside a NoteCard (the first real textarea; see noteTextarea).
function quoteTextarea(page: Page, rowId: string) {
  return page.locator(`[data-note-id="${rowId}"]`).locator('textarea:not([aria-hidden="true"])').nth(0);
}

// Build the note's quote from the source text: open the picker from the card,
// pick the verse's last Hebrew word (unlikely to be the stored quote), use the
// selection. The card must be active.
async function buildQuoteFromLastWord(page: Page, rowId: string) {
  // The button's accessible name is its tooltip; match its label instead.
  await page.locator(`[data-note-id="${rowId}"]`).getByRole("button").filter({ hasText: /^build from source$/ }).click();
  const useSelection = page.getByRole("button", { name: "Use selection" });
  const picker = page.getByRole("tooltip").filter({ has: useSelection });
  await picker.locator(".MuiChip-root").filter({ hasText: /[֐-׿]/ }).last().click();
  await useSelection.click();
}

for (const [i, withNote] of [false, true].entries()) {
  test(`tN card: after the card's own quote build lands${withNote ? " (with unsaved note text)" : ""}, a quote edit saves at the current version`, async ({
    browser,
  }) => {
    // Round 4, item 1. A quote build is the translator's own write of the row,
    // made from the card. Once it lands, the card's next Save must go out at
    // the landed version: holding on to the copy from before the build sends
    // it at the old version, and the server's 409 (the quote changed since
    // that copy) shows a conflict against the translator's own build. With
    // unsaved note text the card's draft outlives the build, so the copy has
    // to move with the build rather than be let go with the draft.
    test.setTimeout(90_000);
    const probe = await apiRequest.newContext({ baseURL: BASE });
    const auth = await mintToken(probe, `probe-754-build-${i}`);
    const [tn] = await pairFromEnd(probe, auth.token, 2 + i);
    const { context } = await newUserContext(browser, `restored-draft-754-build-${i}`);
    const page = await context.newPage();

    const sent: Array<{ ifMatch: string | undefined; body: Record<string, unknown>; status: number }> = [];
    await context.route(`**/api/rows/tn/${tn.id}**`, async (route, request) => {
      if (request.method() !== "PATCH") return route.continue();
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      const response = await route.fetch();
      sent.push({ ifMatch: request.headers()["if-match"], body, status: response.status() });
      return route.fulfill({ response });
    });

    await gotoVerse(page, "ZEC", CHAPTER, tn.verse);
    await noteTextarea(page, tn.id).click();
    const typedNote = `BUILD NOTE 754 ${Date.now()}`;
    if (withNote) await noteTextarea(page, tn.id).fill(typedNote);
    await buildQuoteFromLastWord(page, tn.id);
    await expect
      .poll(() => sent.filter((s) => "quote" in s.body && s.status === 200).length, {
        message: "the quote build should land",
      })
      .toBe(1);
    expect(sent[0].ifMatch).toBe(String(tn.version));
    await page.waitForTimeout(1000);

    const editedQuote = `${await quoteTextarea(page, tn.id).inputValue()} EDITED`;
    await quoteTextarea(page, tn.id).fill(editedQuote);
    await saveNote(page, tn.id);
    await expect.poll(() => sent.length, { message: "the Save should reach the server" }).toBe(2);
    await page.waitForTimeout(1000);
    console.log(
      `[#754 build ${withNote ? "with note" : "quote only"}]`,
      JSON.stringify({ sent: sent.map((s) => ({ ...s, body: Object.keys(s.body) })) }),
    );
    expect(sent[1].ifMatch, "the Save goes out at the version the build landed at").toBe(String(tn.version + 1));
    expect(
      sent.map((s) => s.status),
      "no conflict against the translator's own build",
    ).toEqual([200, 200]);
    await expect(page.getByText(/^1 conflict$/)).toHaveCount(0);
    const after = (await fetchChapter(probe, auth.token, "ZEC", CHAPTER)).tn.find((r) => r.id === tn.id)!;
    expect(after.quote).toBe(editedQuote);
    if (withNote) expect(after.note).toBe(typedNote);

    await probe.dispose();
    await context.close();
  });
}

test("tN card: while a restored draft's Save waits in conflict, the row moving on does not allow a second Save", async ({
  browser,
}) => {
  // Round 4, item 2. The Save button stays shut while the card's save is
  // unresolved. A restored draft's Save ends in a conflict; if the row then
  // moves again (the other person saves again) the button must stay shut, or
  // a second Save goes out at the old version too and "resolve" sends both.
  test.setTimeout(90_000);
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const other = await mintToken(probe, "other-754-double");
  const [tn] = await pairFromEnd(probe, other.token, 4);
  const key = `row:tn:ZEC:${tn.id}`;
  const { context } = await newUserContext(browser, "restored-draft-754-double");
  const page = await context.newPage();

  const sent: Array<{ ifMatch: string | undefined; status: number }> = [];
  await context.route(`**/api/rows/tn/${tn.id}**`, async (route, request) => {
    if (request.method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    sent.push({ ifMatch: request.headers()["if-match"], status: response.status() });
    return route.fulfill({ response });
  });
  // Live updates for this row reaching the page.
  let pushes = 0;
  page.on("websocket", (ws) =>
    ws.on("framereceived", (f) => {
      if (String(f.payload).includes(tn.id)) pushes++;
    }),
  );

  await gotoVerse(page, "ZEC", CHAPTER, tn.verse);
  const typed = `DOUBLE 754 ${Date.now()}`;
  await noteTextarea(page, tn.id).fill(typed);
  await expect
    .poll(async () => (await readDraft(page, key))?.payload?.patch ?? null)
    .toEqual(expect.objectContaining({ note: typed }));
  await gotoVerse(page, "ZEC", AWAY_CHAPTER, 1);

  const api = authedRequest(probe, other.token, other.csrf);
  const res = await api.patch(`/api/rows/tn/${tn.id}?book=ZEC`, { note: `OTHER 754 DOUBLE ${Date.now()}` }, tn.version);
  expect(res.status()).toBe(200);

  await page.goto(`/#/ZEC/${CHAPTER}/${tn.verse}`);
  await page.reload();
  await page.locator("[data-note-id]").first().waitFor({ timeout: 10_000 });
  await expect(noteTextarea(page, tn.id)).toHaveValue(typed);
  await page.waitForTimeout(1000);
  await saveNote(page, tn.id);
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ ifMatch: String(tn.version), status: 409 });
  await expect(page.getByText(/^1 conflict$/).first()).toBeVisible({ timeout: 10_000 });

  // The other person saves again; wait for the live update to reach the page.
  const before = pushes;
  const res2 = await api.patch(
    `/api/rows/tn/${tn.id}?book=ZEC`,
    { note: `OTHER 754 DOUBLE AGAIN ${Date.now()}` },
    tn.version + 1,
  );
  expect(res2.status()).toBe(200);
  await expect
    .poll(() => pushes, { message: "the live update should reach the page", timeout: 10_000 })
    .toBeGreaterThan(before);
  await page.waitForTimeout(1000);

  const save = page.locator(`[data-note-id="${tn.id}"]`).locator('button:has([data-testid="SaveIcon"])');
  const enabled = (await save.count()) > 0 && (await save.isEnabled());
  if (enabled) await save.click();
  await page.waitForTimeout(1500);
  console.log("[#754 double]", JSON.stringify({ saveEnabledAfterMove: enabled, sent }));
  expect(enabled, "Save stays shut while the first Save waits in conflict").toBe(false);
  expect(sent, "only one Save went out").toHaveLength(1);

  await probe.dispose();
  await context.close();
});
