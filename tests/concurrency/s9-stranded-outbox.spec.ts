import { expect, test, request as apiRequest, type Page } from "@playwright/test";
import {
  fetchChapter,
  saveNote,
  gotoVerse,
  mintToken,
  newUserContext,
  noteTextarea,
  waitForServerNote,
} from "./helpers";

const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";

// S9 — issue #502. The outbox's IndexedDB name is resolved once per session
// from the workspace fallback flag, which boot writes only after
// /api/auth/me lands. outbox.ts opens its DB at module load, so on a first
// visit (flag absent) the fallback workspace `bsoj` opens the SUFFIXED
// `bible-editor-outbox-bsoj`, while every later session (flag "1") opens the
// unsuffixed `bible-editor-outbox`. An edit queued offline in the first
// session used to be stranded there forever. With adopt-on-open, the next
// session moves it into the database it opened and drains it.

const SUFFIXED = "bible-editor-outbox-bsoj";

const ANY_STATUS = ["pending", "in_flight", "conflict", "failed"];

// Count ops in one of `statuses` whose payload contains `needle` in ONE named
// database. Opens only a database that already exists (indexedDB.open would
// otherwise create it and change what the app sees). Returns null when the
// read itself fails, so neither assertion can pass on an error.
function countOpsIn(page: Page, dbName: string, needle: string, statuses: string[]) {
  return page.evaluate(
    async ({ dbName, needle, statuses }) => {
      try {
        const meta = (await indexedDB.databases()).find((d) => d.name === dbName);
        if (!meta) return 0;
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open(dbName, meta.version);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        try {
          if (!db.objectStoreNames.contains("ops")) return 0;
          const ops: Array<Record<string, unknown>> = await new Promise((resolve, reject) => {
            const req = db.transaction("ops", "readonly").objectStore("ops").getAll();
            req.onsuccess = () => resolve(req.result as Array<Record<string, unknown>>);
            req.onerror = () => reject(req.error);
          });
          return ops.filter(
            (o) =>
              statuses.includes(o.status as string) && JSON.stringify(o).includes(needle),
          ).length;
        } finally {
          db.close();
        }
      } catch {
        // null, not 0: a failed read must never pass the "stranded copy is
        // gone" check below. expect.poll retries it and fails if it persists.
        return null;
      }
    },
    { dbName, needle, statuses },
  );
}

test("an edit queued offline before the fallback flag lands still flushes after a new session (#502)", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const probeAuth = await mintToken(probe, "probe");
  const chapter = await fetchChapter(probe, probeAuth.token, "ZEC", 6);
  const target = chapter.tn.find((r) => r.verse === 2) ?? chapter.tn.find((r) => r.verse === 1);
  expect(target, "expected a TN row on ZEC 6 in the seed").toBeTruthy();
  await probe.dispose();

  const { context } = await newUserContext(browser, "alice");
  // One-shot first-visit state: slug known, fallback flag absent. The marker
  // keeps this from re-clearing the flag in the second session's page.
  await context.addInitScript(() => {
    try {
      if (localStorage.getItem("s9.primed") === "1") return;
      localStorage.setItem("s9.primed", "1");
      localStorage.setItem("bible-editor.workspace", "bsoj");
      localStorage.removeItem("bible-editor.workspace-is-fallback");
      localStorage.removeItem("bible-editor.workspace-fallback-for");
    } catch {
      /* about:blank has no localStorage */
    }
  });

  // ── Session 1: first visit. ──
  const page1 = await context.newPage();
  await gotoVerse(page1, "ZEC", 6, target!.verse);
  // Boot reconciliation writes the flag AFTER the outbox already opened.
  await expect
    .poll(() => page1.evaluate(() => localStorage.getItem("bible-editor.workspace-is-fallback")), {
      timeout: 10_000,
    })
    .toBe("1");

  await context.setOffline(true);
  const offlineText = `STRANDED alice ${Date.now()}`;
  await noteTextarea(page1, target!.id).fill(offlineText);
  await saveNote(page1, target!.id);

  // Precondition: the op must sit PENDING in the SUFFIXED database. If the app
  // opened the unsuffixed one, this run does not exercise #502 and must not
  // pass. "pending" (not in_flight) pins the path under test: an in-flight op
  // is deliberately held in the sibling until its request has provably timed
  // out (IN_FLIGHT_RECOVERY_AGE_MS), which this spec does not wait for.
  await expect
    .poll(() => countOpsIn(page1, SUFFIXED, offlineText, ["pending"]), {
      timeout: 10_000,
      message: `expected the offline op pending in ${SUFFIXED} (the pre-flag database)`,
    })
    .toBeGreaterThan(0);

  // Close while still offline, so session 1 can never drain its own outbox.
  await page1.close();
  await context.setOffline(false);

  const side = await apiRequest.newContext({ baseURL: BASE });
  const sideAuth = await mintToken(side, "verifier");
  const before = await fetchChapter(side, sideAuth.token, "ZEC", 6);
  expect(before.tn.find((r) => r.id === target!.id)?.note ?? "").not.toBe(offlineText);

  // ── Session 2: flag is "1", so the app opens the unsuffixed outbox. ──
  const page2 = await context.newPage();
  await gotoVerse(page2, "ZEC", 6, target!.verse);

  const final = await waitForServerNote(
    side,
    sideAuth.token,
    "ZEC",
    6,
    target!.id,
    (n) => n === offlineText,
    30_000,
  );
  expect(final.note).toBe(offlineText);
  // And no copy of the op is left in the suffixed DB (in any status), so no
  // later session re-sends it.
  await expect
    .poll(() => countOpsIn(page2, SUFFIXED, offlineText, ANY_STATUS), {
      timeout: 10_000,
      message: `expected no copy of the op left in ${SUFFIXED}`,
    })
    .toBe(0);

  await side.dispose();
  await context.close();
});
