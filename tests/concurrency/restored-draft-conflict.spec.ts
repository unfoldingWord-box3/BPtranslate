import { expect, test, request as apiRequest, type Page } from "@playwright/test";
import { authedRequest, fetchChapter, gotoVerse, mintToken, newUserContext, noteTextarea, saveNote } from "./helpers";

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
// ZEC 13 is used because no other spec writes to it; globalSetup re-imports
// ZEC each run.
const CHAPTER = 13;
const AWAY_CHAPTER = 12;

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
