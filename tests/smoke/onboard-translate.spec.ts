import { test, expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { newUserContext, fetchChapter, gotoVerse, type TnRow } from "../concurrency/helpers";

// Empty DB → dev-auth admin → Setup wizard onboarding into SMOKE_ORG → import
// OBA → scripture visible → AI translate via the stubbed bot (see
// scripts/translate-stub-server.mjs) → job done → ai_draft row → approve →
// validated. The real fly.io bot stays out of scope; PIPELINE_API_BASE points
// at the stub (wired in scripts/dev-smoke.mjs).
//
// One long serial test rather than several independent ones: every stage
// depends on D1 state the previous stage created (onboarded org → imported
// book → translated row → approved row), and global-setup only gives us one
// truly-empty database per run.
const SMOKE_ORG = process.env.SMOKE_ORG ?? "BSOJ";
const BOOK = "OBA";

// KNOWN RISK (see task/PR description): the stub applies translated rows by
// en_tn row ID. If SMOKE_ORG's ar_tn IDs for OBA don't overlap
// unfoldingWord/en_tn's, no *specific* row lands as ai_draft even though the
// job completes successfully. `findDraftRow` below tries the row we asked for
// first, then falls back to "any ai_draft row with the stub marker" so the
// test still proves the pipeline works end-to-end.
function findDraftRow(rows: TnRow[], requestedId: string): (TnRow & { translation_state?: string }) | undefined {
  const withState = rows as (TnRow & { translation_state?: string })[];
  return (
    withState.find((r) => r.id === requestedId && r.translation_state === "ai_draft") ??
    withState.find((r) => r.translation_state === "ai_draft" && r.note?.startsWith("[AR-STUB]"))
  );
}

async function pollJob(request: APIRequestContext, jobId: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last: { state: string; [k: string]: unknown } | undefined;
  while (Date.now() < deadline) {
    const res = await request.get(`/api/pipelines/${encodeURIComponent(jobId)}`);
    expect(res.status(), `poll ${jobId} returned ${res.status()}`).toBeLessThan(500);
    last = await res.json();
    if (last.state === "done" || last.state === "failed") return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`job ${jobId} did not reach a terminal state within ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

test.describe.serial("onboarding + AI translate smoke", () => {
  test.setTimeout(300_000);

  test("empty DB onboards into an org, imports OBA, and drives an AI translate → approve round trip", async ({
    browser,
  }) => {
    const { context, auth } = await newUserContext(browser, "admin");
    const page = await context.newPage();

    await test.step("mint admin session", async () => {
      expect(auth.userId).toBeTruthy();
      expect(auth.csrf).toBeTruthy();
    });

    // Per-action timeout so a stale selector fails in seconds and the API
    // fallback below actually gets to run. Without one, a single .click()
    // against a button the redesigned wizard no longer renders eats the whole
    // 300s test budget and the catch block never executes (#494).
    const ACTION_MS = 15_000;
    // Gates that wait on a DCS round trip (org detection, apply) get more.
    const NETWORK_MS = 60_000;

    await test.step("drive Setup wizard: confirm org, sources, lanes, apply", async () => {
      await page.goto("/#/preferences/setup");
      const wizard = page.locator('section[aria-labelledby="setup-wizard-heading"]');
      await expect(wizard).toBeVisible();

      // MUI's Collapse (StepContent's exit transition) unmounts the outgoing
      // step only after its animation finishes — so right after a "Next" click
      // there's a brief window where both the outgoing and incoming steps'
      // buttons coexist in the DOM. Wait for the count to settle back to one
      // before clicking, or a locator resolving to two elements throws a
      // strict-mode violation.
      const next = wizard.getByRole("button", { name: /^next$/i });
      const clickNext = async () => {
        await expect(next).toHaveCount(1, { timeout: ACTION_MS });
        await expect(next).toBeEnabled({ timeout: NETWORK_MS });
        await next.click({ timeout: ACTION_MS });
      };

      try {
        // Step 1 — "Your organization". Nothing is typed here any more: the org
        // is read from the current workspace (read-only), detection fires on
        // mount, and the resource language is pre-seeded from the proposal. So
        // the only gate is Next becoming enabled (draft detected + language).
        // NB: because the org is no longer typed, the UI path can only configure
        // the CURRENT workspace's org — SMOKE_ORG must match it (both default to
        // BSOJ, the first entry in wrangler.toml's WORKSPACES). Pointing
        // SMOKE_ORG somewhere else drops this step into the API fallback.
        await expect(wizard.getByText(SMOKE_ORG, { exact: true }).first()).toBeVisible({
          timeout: NETWORK_MS,
        });
        await clickNext();

        // Step 2 — "Sources to pull from". unfoldingWord is the default upstream
        // and is marked verified without a round trip, and every resource row is
        // checked (= pull from upstream) by default, so the defaults are already
        // what this suite wants. Assert the upstream org rather than just the
        // field's presence: a changed default would otherwise sail past here and
        // surface much later as "no tn rows imported for OBA 1".
        await expect(wizard.getByLabel(/default upstream org/i)).toHaveValue("unfoldingWord", {
          timeout: ACTION_MS,
        });
        await clickNext();

        // Step 3 — "Your scripture lanes". SMOKE_ORG's lit/sim roles are
        // ambiguous, so detection leaves both target-repo fields empty; resolve
        // them to the AVD/NAV pair (the same choice the API fallback makes).
        // Both fields share the "Target repository" label and are told apart by
        // their per-lane placeholders.
        await wizard.getByPlaceholder("ru_rlob").fill("ar_avd", { timeout: ACTION_MS });
        await wizard.getByPlaceholder("es-419_gst").fill("ar_nav", { timeout: ACTION_MS });
        await clickNext();

        // Step 4 — "Review & apply". Apply persists the custom-gl overrides and
        // then patches each lane's edit/align mode before advancing.
        const apply = wizard.getByRole("button", { name: /apply configuration/i });
        await expect(apply).toBeEnabled({ timeout: ACTION_MS });
        await apply.click({ timeout: ACTION_MS });

        // Step 5 — "Done". Setup no longer imports a book (that moved to the
        // Books screen), so reaching Done is the end of the UI path; the import
        // below always goes through the API.
        await expect(wizard.getByRole("button", { name: /go to import/i })).toBeVisible({
          timeout: NETWORK_MS,
        });
      } catch (e) {
        // Wizard-drive fallback: drive the same contract directly via the API
        // the wizard itself calls, and downgrade the assertion to "wizard
        // rendered" rather than a full click-through proof. The per-action
        // timeouts above are what make this reachable.
        console.warn(`[smoke] UI wizard drive failed (${e}); falling back to API apply`);
        const detectRes = await context.request.get(`/api/orgs/${encodeURIComponent(SMOKE_ORG)}/inferred-config`);
        expect(detectRes.ok(), `GET inferred-config: ${detectRes.status()}`).toBeTruthy();
        const inferred = await detectRes.json();
        const repos: Record<string, string> = { ...inferred.proposal.repos };
        for (const a of inferred.ambiguous as { role: string; candidates: string[] }[]) {
          repos[a.role] = a.role === "lit" ? "ar_avd" : a.role === "sim" ? "ar_nav" : a.candidates[0];
        }
        const overrides = {
          org: inferred.org,
          exportOrg: inferred.proposal.suggestedExportOrg,
          languageCode: inferred.proposal.languageCode ?? inferred.org,
          languageName: inferred.proposal.languageName ?? inferred.org,
          languageTitle: inferred.proposal.languageTitle ?? inferred.org,
          direction: inferred.proposal.direction,
          repos,
          litLabel: inferred.proposal.litLabel ?? repos.lit?.toUpperCase() ?? "LIT",
          simLabel: inferred.proposal.simLabel ?? repos.sim?.toUpperCase() ?? "SIM",
          translationSource: {
            org: "unfoldingWord",
            languageCode: "en",
            repos: { lit: "en_ult", sim: "en_ust", tn: "en_tn", tq: "en_tq", twl: "en_twl", tw: "en_tw", ta: "en_ta" },
          },
        };
        const applyRes = await context.request.put("/api/project-config", {
          headers: { "x-csrf-token": auth.csrf, "Content-Type": "application/json" },
          data: { preset: "custom-gl", overrides },
        });
        expect(applyRes.ok(), `PUT project-config fallback: ${applyRes.status()} ${await applyRes.text()}`).toBeTruthy();
      }
    });

    await test.step("import OBA and populate articles", async () => {
      // Always via the API: the redesigned wizard configures only — importing
      // moved out of Setup and onto the Books screen.
      const importRes = await context.request.post(`/api/books/${BOOK}/import`, {
        headers: { "x-csrf-token": auth.csrf },
        timeout: 120_000,
      });
      expect(importRes.ok(), `import ${BOOK}: ${importRes.status()} ${await importRes.text()}`).toBeTruthy();
      for (let round = 0; round < 60; round++) {
        const r = await context.request.post("/api/articles/populate", {
          headers: { "x-csrf-token": auth.csrf, "Content-Type": "application/json" },
          data: { book: BOOK },
        });
        expect(r.ok()).toBeTruthy();
        const body = await r.json();
        if (body.skipped || body.aborted || body.remaining === 0) break;
      }
    });

    let rowIdToTranslate = "";
    await test.step("scripture + notes visible", async () => {
      const chapter = await fetchChapter(context.request, auth.token, BOOK, 1);
      expect(chapter.tn.length, "no tn rows imported for OBA 1").toBeGreaterThan(0);
      rowIdToTranslate = chapter.tn[0].id;

      await gotoVerse(page, BOOK, 1, 1);
      await expect(page.locator("[data-note-id]").first()).toBeVisible();
    });

    let jobId = "";
    await test.step("start AI translate via the stub bot", async () => {
      const res = await context.request.post("/api/pipelines/start", {
        headers: { "x-csrf-token": auth.csrf, "Content-Type": "application/json" },
        data: {
          pipelineType: "translate",
          book: BOOK,
          startChapter: 1,
          endChapter: 1,
          sessionKey: "smoke-translate-1",
          translate: { rowIds: [rowIdToTranslate] },
        },
      });
      expect(res.ok(), `pipelines/start: ${res.status()} ${await res.text()}`).toBeTruthy();
      const body = await res.json();
      jobId = body.jobId;
      expect(jobId).toBeTruthy();

      // Negative dedup check while the job is still non-terminal (queued/
      // running) — the server's dedup query only matches active states, so
      // this must run before the job finishes, not after (see PR description).
      const dupRes = await context.request.post("/api/pipelines/start", {
        headers: { "x-csrf-token": auth.csrf, "Content-Type": "application/json" },
        data: {
          pipelineType: "translate",
          book: BOOK,
          startChapter: 1,
          endChapter: 1,
          sessionKey: "smoke-translate-1-dup",
          translate: { rowIds: [rowIdToTranslate] },
        },
      });
      expect(dupRes.status(), `dedup re-POST: ${dupRes.status()} ${await dupRes.text()}`).toBeLessThan(500);
      const dupBody = await dupRes.json();
      expect(dupBody.jobId, "dedup re-POST should return the SAME job id").toBe(jobId);
      expect(dupBody.status).toBe("already_running");
    });

    let draftRow: (TnRow & { translation_state?: string }) | undefined;
    await test.step("poll job to done, verify ai_draft row", async () => {
      const job = await pollJob(context.request, jobId);
      expect(job.state, `job ended in state ${job.state}: ${JSON.stringify(job)}`).toBe("done");

      const chapter = await fetchChapter(context.request, auth.token, BOOK, 1);
      draftRow = findDraftRow(chapter.tn, rowIdToTranslate);
      expect(
        draftRow,
        "no ai_draft row with the [AR-STUB] marker found after the translate job completed " +
          "— possible ID mismatch between the org's ar_tn and unfoldingWord/en_tn for OBA",
      ).toBeTruthy();
      expect(draftRow!.note).toMatch(/^\[AR-STUB\]/);
    });

    await test.step("draft chip renders, approve via NoteCard, becomes validated", async () => {
      const row = draftRow!;
      const [chStr, vStr] = row.ref_raw.split(":");
      const chapterNum = chStr === "front" ? 1 : Number(chStr) || 1;
      const verseNum = Number(vStr) || 1;

      // gotoVerse navigates to the same OBA/1/1 hash the "scripture + notes
      // visible" step already visited (before the translate job ran) — a
      // same-hash "navigation" doesn't fire hashchange, so the SPA's chapter
      // cache never refetches and the card would render stale (pre-translate)
      // content. Reload to force a fresh fetch of the now-drafted row.
      await gotoVerse(page, BOOK, chapterNum, verseNum);
      await page.reload();
      await page.locator("[data-note-id]").first().waitFor({ timeout: 10_000 });
      const card = page.locator(`[data-note-id="${row.id}"]`);
      await expect(card).toBeVisible();
      await expect(card.getByText(/ai draft/i)).toBeVisible();

      await card.getByRole("button", { name: /approve/i }).click();

      const deadline = Date.now() + 15_000;
      let validated = false;
      while (Date.now() < deadline) {
        const chapter = await fetchChapter(context.request, auth.token, BOOK, chapterNum);
        const updated = (chapter.tn as (TnRow & { translation_state?: string })[]).find((r) => r.id === row.id);
        if (updated?.translation_state === "validated") {
          validated = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(validated, "row did not reach translation_state=validated after approve").toBeTruthy();
    });
  });
});
