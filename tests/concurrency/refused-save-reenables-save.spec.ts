import { expect, test, request as apiRequest } from "@playwright/test";
import { fetchChapter, gotoVerse, mintToken, newUserContext, noteTextarea } from "./helpers";

// Honor BE_BASE_URL so the suite runs on a relocated port (mirrors s8).
const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";

// Issue #660. The tN card disables Save while its save is in flight and used to
// re-enable it only when the row's version moved. A refused save (a fatal 422,
// or a 409 "chapter_locked" that the outbox drops) never moves the version, so
// Save stayed disabled and the translator could not re-send the text still on
// screen without a reload.
//
// The first PATCH is held, then refused by page.route and never reaches the
// server; the second goes through to a ZEC 12 tN row on the local server
// (globalSetup re-imports ZEC each run). ZEC 12 is used because no other spec
// writes to it.
const CHAPTER = 12;

interface NoteRow {
  id: string;
  verse: number;
  note: string | null;
}

async function pickNote(): Promise<NoteRow> {
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const auth = await mintToken(probe, "probe-660");
  const chapter = await fetchChapter(probe, auth.token, "ZEC", CHAPTER);
  await probe.dispose();
  const tn = (chapter.tn as NoteRow[]).find((r) => r.verse > 1);
  expect(tn, `expected a tN row after verse 1 on ZEC ${CHAPTER}`).toBeTruthy();
  return tn!;
}

const refusals = [
  { name: "a fatal 422", status: 422, body: { error: "validation_failed" } },
  {
    name: 'a "locked" 409',
    status: 409,
    body: { error: "chapter_locked", jobId: "job-660", pipelineType: "translate", startedAt: 1 },
  },
];

for (const refusal of refusals) {
  test(`tN card: Save is enabled again after ${refusal.name} and re-sends the text`, async ({ browser }) => {
    test.setTimeout(60_000);
    const tn = await pickNote();
    const { context } = await newUserContext(browser, `reenable-tn-${refusal.status}`);
    const page = await context.newPage();

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const bodies: Record<string, unknown>[] = [];
    await context.route(`**/api/rows/tn/${tn.id}**`, async (route, request) => {
      if (request.method() !== "PATCH") return route.continue();
      bodies.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
      if (bodies.length > 1) return route.continue();
      await held;
      await route.fulfill({ status: refusal.status, contentType: "application/json", body: JSON.stringify(refusal.body) });
    });

    await gotoVerse(page, "ZEC", CHAPTER, tn.verse);
    const typed = `REENABLE ${refusal.status} ${Date.now()}`;
    await noteTextarea(page, tn.id).fill(typed);
    const save = page.locator(`[data-note-id="${tn.id}"]`).locator('button:has([data-testid="SaveIcon"])');
    await save.click();
    await expect.poll(() => bodies.length, { message: "the PATCH should reach the route" }).toBe(1);

    // While the save is in flight the button stays disabled (double-click gate).
    await expect(save).toBeDisabled();
    release();

    // After the refusal the text is still on screen and Save works again.
    await expect(noteTextarea(page, tn.id)).toHaveValue(typed);
    await expect(save).toBeEnabled();
    await save.click();
    await expect.poll(() => bodies.length, { message: "the second Save should send a PATCH" }).toBe(2);
    expect(bodies[1]).toEqual(expect.objectContaining({ note: typed }));

    await context.close();
  });
}
