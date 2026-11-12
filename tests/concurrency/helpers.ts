import type { APIRequestContext, Browser, BrowserContext, Page, Request, Route } from "@playwright/test";

// Frontend stores its JWT here (see web/src/sync/api.ts:171).
const TOKEN_KEY = "bible-editor.auth.token";

export interface DevAuth {
  token: string;
  userId: number;
  username: string;
  // be_csrf cookie value captured at mint — writes must mirror it into the
  // X-CSRF-Token header (double-submit; see api/src/auth.ts requireCsrf).
  csrf: string;
}

/**
 * Mint a JWT via /api/auth/dev for `username`. Requires
 * DEV_AUTH_ENABLED=true on the worker (default in api/wrangler.toml [vars]).
 */
export async function mintToken(
  request: APIRequestContext,
  username: string,
): Promise<DevAuth> {
  const res = await request.post("/api/auth/dev", { data: { username } });
  if (!res.ok()) {
    throw new Error(
      `/api/auth/dev for "${username}" returned ${res.status()}: ${await res.text()}`,
    );
  }
  // The mint sets auth (be_access) + CSRF (be_csrf) cookies; the JSON body
  // carries userId/username/role but no bearer token (auth rides the cookie).
  const body = (await res.json()) as Partial<DevAuth>;
  return { ...(body as DevAuth), token: body.token ?? "", csrf: await csrfToken(request) };
}

/** Read the be_csrf cookie this context received at sign-in (for write headers). */
export async function csrfToken(request: APIRequestContext): Promise<string> {
  const { cookies } = await request.storageState();
  return cookies.find((c) => c.name === "be_csrf")?.value ?? "";
}

/**
 * Create a fresh browserContext logged in as `username`. The token is injected
 * via `addInitScript` so it's present on first paint and the app skips the
 * auto-mint path in App.tsx (which would otherwise log in as "dev" and clobber
 * our identity for that context).
 */
export async function newUserContext(
  browser: Browser,
  username: string,
): Promise<{ context: BrowserContext; auth: DevAuth }> {
  const context = await browser.newContext();
  const auth = await mintToken(context.request, username);
  await context.addInitScript(
    ({ key, token }) => {
      try {
        localStorage.setItem(key, token);
      } catch {
        /* private mode etc. */
      }
    },
    { key: TOKEN_KEY, token: auth.token },
  );
  return { context, auth };
}

// The errors Playwright (1.60) raises in a route handler whose page or context
// is torn down mid-handler: route.fetch()/fulfill() on a closed target, a
// fetch cut off when the context's request context is disposed, and a body
// read (res.json()/res.text()) or fulfill({ response }) after that dispose.
const TEARDOWN_ERROR =
  /Target page, context or browser has been closed|Request context disposed\.|[Rr]esponse has been disposed/;

/**
 * Wrap a page.route or context.route handler so a request still in flight when
 * the test closes its context ends quietly instead of failing the test. The
 * app can repeat a request after the test's last assertion (one page load
 * sends GET /api/project-config more than once), and that request can still
 * be inside route.fetch() when the test calls context.close(). Playwright then
 * reports the error "while running route callback", sometimes against the
 * next test (#776, #780).
 *
 * `page` is the page whose closing ends the test; for a context.route, pass
 * the test's page (context.close() closes it too). An error is swallowed only
 * if that page is closed or the error is one of the messages above, which in
 * these specs come only from teardown. The message check covers a rejection
 * that reaches the handler before page.isClosed() turns true. Any other
 * error, such as a non-OK status the handler throws or bad JSON, still fails
 * the test.
 */
export function closeTolerant(
  page: Page,
  handler: (route: Route, request: Request) => Promise<unknown>,
) {
  return async (route: Route, request: Request): Promise<void> => {
    try {
      await handler(route, request);
    } catch (err) {
      if (page.isClosed() || TEARDOWN_ERROR.test(String(err))) return;
      throw err;
    }
  };
}

// Pure-API authed request. Auth rides the context's be_access cookie; writes
// also need the double-submit CSRF header (csrf = the be_csrf cookie value).
export function authedRequest(request: APIRequestContext, token: string, csrf: string) {
  return {
    get: (path: string) =>
      request.get(path, { headers: { Authorization: `Bearer ${token}` } }),
    patch: (path: string, body: unknown, expectedVersion: number) =>
      request.patch(path, {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-csrf-token": csrf,
          "If-Match": String(expectedVersion),
          "Content-Type": "application/json",
        },
        data: body,
      }),
  };
}

export interface TnRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  note: string | null;
  quote: string | null;
  support_reference: string | null;
  occurrence: number | null;
  version: number;
}

export interface ChapterPayload {
  tn: TnRow[];
  tq: unknown[];
  twl: unknown[];
}

export async function fetchChapter(
  request: APIRequestContext,
  token: string,
  book: string,
  chapter: number,
): Promise<ChapterPayload> {
  const res = await request.get(`/api/chapters/${book}/${chapter}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok()) {
    throw new Error(
      `GET /api/chapters/${book}/${chapter} returned ${res.status()}: ${await res.text()}`,
    );
  }
  return (await res.json()) as ChapterPayload;
}

/**
 * Navigate `page` to a specific book/chapter/verse via the hash router. The
 * active verse matters because the resource column filters notes to the
 * active verse by default; targeting a row on verse N means navigating to N.
 */
export async function gotoVerse(
  page: Page,
  book: string,
  chapter: number,
  verse: number,
): Promise<void> {
  const hash = verse > 1 ? `#/${book}/${chapter}/${verse}` : `#/${book}/${chapter}`;
  await page.goto(`/${hash}`);
  await page.locator("[data-note-id]").first().waitFor({ timeout: 10_000 });
}

/**
 * Trigger a NoteCard's manual save. Notes persist in the local draft cache
 * until the user clicks Save — the editor has no autosave — so `fill()` then
 * `saveNote()` enqueues the PATCH into the outbox. The Save icon (SaveIcon vs
 * the outlined idle icon) renders only while the card has unsaved edits, so
 * the locator implicitly waits for the dirty state before clicking.
 */
export async function saveNote(page: Page, rowId: string): Promise<void> {
  await page
    .locator(`[data-note-id="${rowId}"]`)
    .locator('button:has([data-testid="SaveIcon"])')
    .click();
}

/**
 * Locate the Note text field inside a NoteCard.
 *
 * Each MUI multiline TextField renders TWO <textarea> elements: the real
 * editable one, plus a hidden mirror used for auto-resize measurement
 * (`aria-hidden="true" readonly`). We filter to only the real ones, then
 * Note is the second (Quote is the first).
 */
export function noteTextarea(page: Page, rowId: string) {
  return page
    .locator(`[data-note-id="${rowId}"]`)
    .locator('textarea:not([aria-hidden="true"])')
    .nth(1);
}

/**
 * Drain the IndexedDB outbox. Polls /api/chapters until the row's note text
 * matches what we expect, OR a hard timeout. Server is the source of truth.
 */
export async function waitForServerNote(
  request: APIRequestContext,
  token: string,
  book: string,
  chapter: number,
  rowId: string,
  predicate: (note: string | null) => boolean,
  timeoutMs = 10_000,
): Promise<TnRow> {
  const start = Date.now();
  let lastSeen: TnRow | null = null;
  while (Date.now() - start < timeoutMs) {
    const chap = await fetchChapter(request, token, book, chapter);
    const row = chap.tn.find((r) => r.id === rowId);
    if (row) {
      lastSeen = row;
      if (predicate(row.note)) return row;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `waitForServerNote timed out after ${timeoutMs}ms for ${rowId}. Last note seen: ${JSON.stringify(lastSeen?.note)}`,
  );
}
