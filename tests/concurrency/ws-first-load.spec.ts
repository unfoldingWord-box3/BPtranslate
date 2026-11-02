import { expect, test, type Request } from "@playwright/test";
import { newUserContext } from "./helpers";
import { RTL_FIXTURE } from "./global-setup";

// Issue #749: on a first load in a fresh browser, the editors must not send
// API calls under the wrong workspace.
//
// A fresh context has no `bible-editor.workspace` in localStorage, so the
// client claims "default" in X-Workspace, while the dev Worker resolves the
// seeded workspace (WORKSPACE_SLUG, `bsoj`). App.tsx reconciles by writing the
// server's slug and reloading once. Before the fix that reconcile was a parent
// effect, and React runs child effects first, so the editors' mount fetches
// (GET /api/project-config, /api/pipelines, ...) went out with the stale
// header just before the reload. The reload usually aborts them in the
// browser, but a Playwright route handler fetches the request itself, so
// rtl-direction.spec.ts's patched /api/project-config got the 409
// workspace_mismatch and failed in CI (run 41486137559).
//
// The guard: every /api/* request of the first load, including the ones the
// reload aborts, claims the workspace the server settles on. Requests are
// checked as SENT (the `request` event), because aborted ones never produce a
// response.
//
// Not checked: /api/auth/* and /api/ws/*, which the server exempts from the
// workspace check, and GET /api/l10n/overrides. main.tsx fetches the overrides
// once at boot, outside App and before /api/auth/me returns, so on a first load
// it still claims "default" and gets a 409 (harmless: the bundled strings stand
// and the reload fetches them again; tracked in #766).
// That 409 also makes sync/api.ts reload the tab, which raced App's own
// reconcile and usually tore the page down before App's children mounted, so
// the bug showed only now and then. The spec answers the overrides itself, so
// App's reconcile is the only reload and the check sees App's ordering on
// every run.

test.describe.configure({ timeout: 120_000 });

const BOOT_FETCH_OUTSIDE_APP = "/api/l10n/overrides";
const unchecked = (path: string) =>
  path === BOOT_FETCH_OUTSIDE_APP || path.startsWith("/api/auth/") || path.startsWith("/api/ws/");

for (const [name, hash] of [
  ["verse screen", `/#/verse/${RTL_FIXTURE.book}/${RTL_FIXTURE.chapter}/${RTL_FIXTURE.verse}`],
  ["classic chapter view", `/#/${RTL_FIXTURE.book}/1`],
] as const) {
  test(`#749: fresh-context first load of the ${name} claims the right workspace`, async ({ browser }) => {
    const { context } = await newUserContext(browser, "ws-first-load");
    const page = await context.newPage();
    await page.route("https://git.door43.org/**", (route) =>
      route.fulfill({ status: 404, body: "not mocked" }),
    );
    await page.route(`**${BOOT_FETCH_OUTSIDE_APP}`, (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 200, json: { overrides: {}, versions: {} } })
        : route.continue(),
    );
    const sent: { what: string; ws: string }[] = [];
    page.on("request", (req: Request) => {
      const url = new URL(req.url());
      if (!url.pathname.startsWith("/api/") || unchecked(url.pathname)) return;
      const ws = req.headers()["x-workspace"];
      if (ws !== undefined) sent.push({ what: `${req.method()} ${url.pathname}`, ws });
    });

    const configOk = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/project-config" && r.status() === 200,
      { timeout: 60_000 },
    );
    await page.goto(hash);
    await configOk;
    await page.waitForLoadState("networkidle");

    // After the reconcile, localStorage mirrors the server's workspace.
    const settled = await page.evaluate(() => localStorage.getItem("bible-editor.workspace"));
    expect(settled, "the first load should have adopted the server's workspace").toBeTruthy();
    const wrong = sent.filter((s) => s.ws !== settled).map((s) => `${s.what} claimed ${s.ws}`);
    console.log(`[#749 ${name}] ${sent.length} requests, wrong workspace: ${wrong.join("; ") || "none"}`);
    expect(wrong, `API calls sent under a workspace other than ${settled}`).toEqual([]);
    await context.close();
  });
}

// The hold must never become a reload loop. Here /api/auth/me keeps naming
// workspaces the tab can never match (the server itself resolves a different
// one), so the reconcile cannot converge. The tab may reload a bounded number
// of times (App's reconcile once, sync/api.ts's 409 handler once), then must
// render the app instead of holding or reloading forever.
test("#749: a workspace the server keeps reporting differently does not reload-loop", async ({ browser }) => {
  const { context } = await newUserContext(browser, "ws-first-load-loop");
  const page = await context.newPage();
  await page.route("https://git.door43.org/**", (route) =>
    route.fulfill({ status: 404, body: "not mocked" }),
  );
  // A new name on every call, so the slug the reconcile stores never matches
  // what the next /api/auth/me reports.
  let calls = 0;
  await page.route("**/api/auth/me", async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    return route.fulfill({ response: res, json: { ...json, workspace: `never-matches-749-${++calls}` } });
  });
  let navigations = 0;
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) navigations++;
  });
  await page.goto(`/#/verse/${RTL_FIXTURE.book}/${RTL_FIXTURE.chapter}/${RTL_FIXTURE.verse}`);
  // The screen's own title, not the "signing in" spinner. Its data may fail
  // (409s are expected while the workspaces disagree); it must just render.
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 60_000 });
  const settled = navigations;
  await page.waitForTimeout(5_000);
  console.log(`[#749 loop guard] navigations: ${navigations}`);
  expect(navigations, "the tab kept reloading").toBe(settled);
  expect(navigations, "more reloads than the two one-shot guards allow").toBeLessThanOrEqual(3);
  await context.close();
});
