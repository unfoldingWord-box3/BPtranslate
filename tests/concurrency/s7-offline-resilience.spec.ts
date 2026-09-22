import { expect, test, request as apiRequest } from "@playwright/test";
import {
  fetchChapter,
  saveNote,
  gotoVerse,
  mintToken,
  newUserContext,
  noteTextarea,
  waitForServerNote,
} from "./helpers";

// Honor BE_BASE_URL so the suite runs on a relocated port (mirrors s8).
const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";

// S7 — Offline resilience. Exercises the Level 1 stability features end-to-
// end: the outbox keeps edits durable while the connection is dropped, the
// SyncStatusBar reflects the offline state, and a reconnect drains queued
// ops without user action.

test("edits queued while offline survive and flush on reconnect", async ({ browser }) => {
  // The outbox poll below can legitimately take up to 10s on a loaded machine,
  // which pushes this test's worst-case serial budget past playwright.config's
  // 30s default. Without this, a slow-but-successful poll fails as "Test
  // timeout of 30000ms exceeded" — a worse diagnostic than the flake this
  // spec's fix (#501) removed.
  test.setTimeout(60_000);
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const probeAuth = await mintToken(probe, "probe");
  const chapter = await fetchChapter(probe, probeAuth.token, "ZEC", 6);
  const target = chapter.tn.find((r) => r.verse === 1);
  expect(target, "expected a TN row on ZEC 6:1 in the seed").toBeTruthy();
  await probe.dispose();

  const { context } = await newUserContext(browser, "alice");
  const page = await context.newPage();
  await gotoVerse(page, "ZEC", 6, target!.verse);

  // Drop the network *after* the chapter has loaded so the resource column
  // is rendered and the note card mounts. The next save attempt then has to
  // queue and wait for the connection to come back.
  await context.setOffline(true);

  const offlineText = `OFFLINE alice ${Date.now()}`;
  await noteTextarea(page, target!.id).fill(offlineText);
  // Click Save while offline — the PATCH can't reach the server, so it stays a
  // pending op in the outbox (asserted below). No autosave: Save is explicit.
  await saveNote(page, target!.id);

  // The op has to be durably queued in the outbox. Reading IndexedDB directly
  // avoids coupling the assertion to the SyncStatusBar's render timing or chip
  // text. Store schema per outbox.ts: store "ops" with a "status" field.
  //
  // Count across EVERY "bible-editor-outbox*" database rather than one fixed
  // name (#501). outboxDbName() suffixes per workspace, and the fallback
  // workspace keeps the legacy unsuffixed name — but "is this the fallback"
  // is only known once the flag lands in localStorage, so a save early in the
  // boot conservatively suffixes and a later one does not. Hardcoding
  // "bible-editor-outbox" therefore read an unrelated database about half the
  // time, and because indexedDB.open() CREATES a missing database, it silently
  // returned 0 instead of erroring. Enumerate first and open only what exists,
  // so this assertion never creates a database of its own.
  //
  // Polled, not sampled after a fixed sleep: enqueueing is a debounce plus an
  // IndexedDB transaction and overruns any fixed delay on a loaded machine. It
  // cannot race the other way — the context stays offline for this whole
  // window, so a queued op cannot drain.
  // Matched on offlineText, which is unique per run, so this counts THIS edit
  // rather than "some pending op" — a later auto-enqueue elsewhere in the app
  // can't satisfy it, and neither can a leftover from another database.
  const readQueuedOpCount = (text: string) => () =>
    page.evaluate(async (needle) => {
      try {
        const open = (name: string, version?: number) =>
          new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(name, version);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
        const dbs = (await indexedDB.databases()).filter((d) =>
          (d.name ?? "").startsWith("bible-editor-outbox"),
        );
        let queued = 0;
        for (const meta of dbs) {
          const db = await open(meta.name!, meta.version);
          try {
            if (!db.objectStoreNames.contains("ops")) continue;
            const ops: Array<Record<string, unknown>> = await new Promise((resolve, reject) => {
              const tx = db.transaction("ops", "readonly");
              const req = tx.objectStore("ops").getAll();
              req.onsuccess = () => resolve(req.result as Array<Record<string, unknown>>);
              req.onerror = () => reject(req.error);
            });
            queued += ops.filter(
              (o) =>
                (o.status === "pending" || o.status === "in_flight") &&
                JSON.stringify(o).includes(needle),
            ).length;
          } finally {
            // finally, so a rejected getAll can't leak a connection across the
            // poll's repeated runs and block a future version upgrade.
            db.close();
          }
        }
        return queued;
      } catch {
        // Retry rather than hard-fail: expect.poll does NOT catch an exception
        // thrown by the generator itself, so a transient DOMException would
        // abort the poll with a raw error instead of polling on.
        return 0;
      }
    }, text);
  await expect
    .poll(readQueuedOpCount(offlineText), {
      timeout: 10_000,
      message: "expected at least one pending outbox op while offline",
    })
    .toBeGreaterThan(0);

  // While offline the server must NOT see the edit. Verify via a separate
  // request context that bypasses the offline browser network.
  const sideCtx = await apiRequest.newContext({ baseURL: BASE });
  const sideAuth = await mintToken(sideCtx, "verifier");
  const beforeOnline = await fetchChapter(sideCtx, sideAuth.token, "ZEC", 6);
  const beforeRow = beforeOnline.tn.find((r) => r.id === target!.id);
  expect(beforeRow?.note ?? "").not.toBe(offlineText);

  // Reconnect — outbox listens for `online` and drains immediately.
  await context.setOffline(false);

  // Wait for the server to receive the edit. The outbox dispatcher will
  // hit the next backoff tick on reconnect; allow a generous 10s.
  const final = await waitForServerNote(
    sideCtx,
    sideAuth.token,
    "ZEC",
    6,
    target!.id,
    (n) => n === offlineText,
  );
  expect(final.note).toBe(offlineText);

  await sideCtx.dispose();
  await context.close();
});

test("server flakiness triggers retry; eventual success drains the outbox", async ({ browser }) => {
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const probeAuth = await mintToken(probe, "probe");
  const chapter = await fetchChapter(probe, probeAuth.token, "ZEC", 7);
  const target = chapter.tn.find((r) => r.verse === 1);
  expect(target, "expected a TN row on ZEC 7:1").toBeTruthy();
  await probe.dispose();

  const { context } = await newUserContext(browser, "bob");
  const page = await context.newPage();

  // Fail the first three PATCHes against any TN row with a 503; subsequent
  // requests pass through normally. The outbox backoff sequence is
  // 250→500→1000ms so three failures stretch ~1.75s before recovering.
  let failures = 0;
  await context.route("**/api/rows/tn/**", async (route, request) => {
    if (request.method() === "PATCH" && failures < 3) {
      failures++;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "transient" }),
      });
      return;
    }
    await route.continue();
  });

  await gotoVerse(page, "ZEC", 7, target!.verse);
  const flakyText = `FLAKY bob ${Date.now()}`;
  await noteTextarea(page, target!.id).fill(flakyText);
  await saveNote(page, target!.id);

  const sideCtx = await apiRequest.newContext({ baseURL: BASE });
  const sideAuth = await mintToken(sideCtx, "verifier-flaky");
  const final = await waitForServerNote(
    sideCtx,
    sideAuth.token,
    "ZEC",
    7,
    target!.id,
    (n) => n === flakyText,
    15_000,
  );
  expect(final.note).toBe(flakyText);
  expect(failures, "expected the 503 route to fire 3 times before the real save landed").toBe(3);

  await sideCtx.dispose();
  await context.close();
});
