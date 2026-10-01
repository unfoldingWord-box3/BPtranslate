import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expect,
  test,
  request as apiRequest,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { fetchChapter, mintToken, newUserContext } from "./helpers";
import { RTL_FIXTURE } from "./global-setup";
import { expectRtlPaint } from "./rtl-paint";

// Honor BE_BASE_URL so the suite runs on a relocated port (mirrors s1/s8).
const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";

// RTL direction guard (issues #293, #486).
//
// An RTL regression — Arabic scripture rendered LTR in the flows notes view's
// lanes, the period on the wrong side — reached the deployed dev worker and was
// caught by a human the night before a partner demo (fixed in PR #292, which
// wrapped the lane text in `dir="auto"`). The flows screens share no rendering
// code with the classic editor, so a fix in one place says nothing about the
// others; typecheck/build/lib tests can't see layout. Only a real browser
// resolves `dir` and lays out bidi text.
//
// Two kinds of assertion:
//
//   - COMPUTED direction (`getComputedStyle(el).direction`) — the original #293
//     guard. Necessary but not sufficient: the value can be right while the
//     line still paints wrong (a child overriding `dir`, a bidi-isolation break
//     around punctuation or an embedded Latin token).
//   - PAINT (#486) — rtl-paint.ts reads where the browser actually laid out each
//     glyph (Range.getClientRects) and asserts the sentence-final period is the
//     LEFTMOST glyph on its line and the embedded Latin token "AVD" sits in RTL
//     word order with its own letters left-to-right. Geometry, not pixel
//     baselines: a `toHaveScreenshot()` baseline generated on one Chromium build
//     and font set fails on CI's ubuntu runner, while glyph boxes do not depend
//     on either. Textareas are the one exception — a Range cannot measure a
//     form control's value — so the textarea surfaces assert computed direction
//     only.
//
// Fixture (global-setup.ts RTL_FIXTURE): ULT ZEC 6:1 is an Arabic sentence (in
// both plain_text and content_json) and tn row f66i on ZEC 6:11 is an Arabic
// note; UST stays English. The seeded workspace is the LTR `en-unfoldingword`
// project, so surfaces whose direction comes from the PROJECT language
// (versionIsRtl / projectConfig.direction) are opened with the client's view of
// /api/project-config switched to `direction: "rtl"` — an Arabic target project
// — without touching the shared DB row other specs rely on. Surfaces using
// `dir="auto"` follow the content and need no switch. UI chrome surfaces (home,
// admin desk) are opened with the Arabic UI language (be:uiLang = "ar").
//
// Surfaces NOT covered here, by name, with the reason (#486 asks for this list
// instead of silent skips):
//
//   - flows/ScriptureScreen + ScriptureLane — unreachable for the fixture book:
//     #/scripture/ZEC/... routes to TranslateScriptureScreen; only a bare
//     #/scripture reaches the old screen, and it opens OBA, which is not seeded.
//   - WordsLexiconStrip, UhbStrip, QuoteBuilderPopper, ReviewSourceStrip,
//     OriginalLanguagePanel — show only the Hebrew original + English glosses,
//     never target-language text; the Hebrew `versionIsRtl("UHB")` path is
//     already guarded by the classic + book-view cases below.
//   - flows/UltAlignmentStrip — shows the published English en_ult source, not
//     project content (direction of its lane is `dir="auto"`).
//   - TranslateWordsScreen, ArticlesScreen, ArticleWorkspace, MarkdownView,
//     TerminologySection — need Arabic tW/tA article drafts or target terms; the
//     fixture seeds none yet (TODO, #486). The VerseScreen tA article panel's
//     direction is covered by verse-view-article-inplace.spec.ts (#523).
//   - VerseScreen audit mode — its cells show only ALIGNED fragments of each
//     lane, and the fixture verse is deliberately unaligned, so they are empty.
//   - NoteHistoryDialog (its note field hardcodes dir="ltr"; needs seeded edit
//     history), the ReviewQueue draft field and "Q:" line, the WordsScreen phone
//     "This verse" drawer, QuestionCard (classic translation mode), and the
//     NoteCard note in AUTHORING mode (its dir is unset by design for the
//     English root project) — not yet covered (TODO, #486).
//   - TemplateWorkspace / TemplateHistoryDialog — note templates are English
//     authoring scaffolds, never target-language content.
//   - TopBar — UI chrome only; it sets no `dir` of its own and inherits <html dir>,
//     which the home/admin cases below already exercise.
//
// Known open bugs pinned as `test.fail` (an unexpected pass means the bug was
// fixed — drop the `.fail`):
//   - #451 — VerseScreen target lanes render LTR while projectConfig is null.
//   - #532 — the desktop drag aligner lays Arabic target words out LTR.
//   - #533 — ReviewContextPanel and WordsScreen verse lanes set no `dir`.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AR_UI = JSON.parse(
  readFileSync(resolve(repoRoot, "web/src/i18n/locales/ar.json"), "utf8"),
) as Record<string, Record<string, unknown>>;
/** Arabic UI string at a dotted key, e.g. "flowHome.descScripture". */
function arUi(key: string): string {
  const v = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], AR_UI);
  if (typeof v !== "string") throw new Error(`ar.json has no string at ${key}`);
  return v;
}

/** getComputedStyle(...).direction of the element a locator resolves to. */
function computedDirection(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el as HTMLElement).direction);
}

/**
 * Computed direction of the scripture cell `${chapter}-${verse}-${version}`.
 * ScriptureColumn puts `dir` on the `[data-find-cell]` element itself; BookView
 * puts it on a descendant — so resolve the nearest element that actually bears
 * a `dir` attribute (self or descendant) and read ITS computed direction, since
 * `direction` inherits down and would read LTR on an ancestor above the `dir`.
 */
async function cellDirection(
  page: Page,
  chapter: number,
  verse: number,
  version: string,
): Promise<string> {
  const cell = page.locator(`[data-find-cell="${chapter}-${verse}-${version}"]`).first();
  await cell.waitFor({ state: "visible", timeout: 15_000 });
  return cell.evaluate((el) => {
    const dirEl = (el.matches("[dir]") ? el : el.querySelector("[dir]")) ?? el;
    return getComputedStyle(dirEl as HTMLElement).direction;
  });
}

/**
 * The element whose whole text is the Arabic sentence `text`, inside `scope`.
 * getByText(exact) resolves to the innermost element whose combined text
 * matches, so a lane built from one <button> per word still resolves to the
 * lane box, not one word.
 */
function sentence(scope: Page | Locator, text: string): Locator {
  return scope.getByText(text, { exact: true }).first();
}

/** Computed `rtl` AND painted RTL (period left, Latin token in RTL order). */
async function expectRtlSentence(loc: Locator, label: string, within?: string): Promise<void> {
  await expect(loc, `${label}: Arabic sentence not shown`).toBeVisible({ timeout: 15_000 });
  expect(await computedDirection(loc), `${label}: computed direction`).toBe("rtl");
  await expectRtlPaint(loc, label, { latin: RTL_FIXTURE.latin, within });
}

/**
 * Innermost element whose text CONTAINS `text` — for surfaces that render the
 * Arabic sentence next to other text (an English hint) in the same element.
 * Pair with `expectRtlSentence(..., text)` so only the sentence is measured.
 */
function containing(scope: Page | Locator, text: string): Locator {
  return scope.getByText(text).first();
}

/**
 * The words of the Arabic ULT sentence, in logical order, sentence period
 * dropped — the chips/buttons an aligner renders one per word.
 */
const ULT_WORDS = RTL_FIXTURE.arabicUlt.replace(/\.$/, "").split(" ");

/**
 * Word-per-element surfaces (aligner chips): consecutive words that share a row
 * must step RIGHT-to-left. Rows are compared by vertical overlap so a wrapped
 * strip still checks cleanly.
 */
async function expectRtlWordOrder(scope: Locator, label: string): Promise<void> {
  const boxes: { word: string; x: number; y: number; h: number }[] = [];
  for (const w of ULT_WORDS) {
    const el = scope.getByText(w, { exact: true }).first();
    await expect(el, `${label}: word "${w}" not shown`).toBeVisible({ timeout: 15_000 });
    const b = await el.boundingBox();
    expect(b, `${label}: word "${w}" has no box`).not.toBeNull();
    boxes.push({ word: w, x: b!.x, y: b!.y, h: b!.height });
  }
  let compared = 0;
  for (let i = 0; i + 1 < boxes.length; i++) {
    const a = boxes[i];
    const b = boxes[i + 1];
    if (Math.abs(a.y - b.y) > Math.min(a.h, b.h) / 2) continue; // wrapped to next row
    compared++;
    expect(
      a.x,
      `${label}: "${a.word}" should sit RIGHT of the next word "${b.word}" — ${JSON.stringify(boxes)}`,
    ).toBeGreaterThan(b.x);
  }
  expect(compared, `${label}: no two words shared a row — ${JSON.stringify(boxes)}`).toBeGreaterThan(0);
}

/**
 * Serve this page's GET /api/project-config with the real response patched —
 * by default to an Arabic (RTL) target project. The shared DB row stays
 * `en-unfoldingword`, so no other spec sees the switch.
 */
async function patchProjectConfig(
  page: Page,
  patch: Record<string, unknown> = { direction: "rtl" },
): Promise<void> {
  await page.route("**/api/project-config", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const json = await res.json();
    json.config = { ...json.config, ...patch };
    return route.fulfill({ response: res, json });
  });
}

/** Door43 is never needed by these cases; refuse it so nothing waits on the network. */
async function blockDoor43(page: Page): Promise<void> {
  await page.route("https://git.door43.org/**", (route) =>
    route.fulfill({ status: 404, body: "not mocked" }),
  );
}

interface OpenOpts {
  /** Patch the client's project config (default: none). */
  project?: Record<string, unknown>;
  /** UI language (be:uiLang). */
  uiLang?: string;
  /** localStorage entries, stored as JSON. */
  storage?: Record<string, unknown>;
  viewport?: { width: number; height: number };
}

async function open(
  browser: Browser,
  user: string,
  hash: string,
  opts: OpenOpts = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const { context } = await newUserContext(browser, user);
  await context.addInitScript(
    ({ uiLang, storage }) => {
      try {
        if (uiLang) localStorage.setItem("be:uiLang", uiLang);
        for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, JSON.stringify(v));
      } catch {
        /* private mode etc. */
      }
    },
    { uiLang: opts.uiLang ?? null, storage: opts.storage ?? {} },
  );
  const page = await context.newPage();
  if (opts.viewport) await page.setViewportSize(opts.viewport);
  await blockDoor43(page);
  if (opts.project) await patchProjectConfig(page, opts.project);
  await page.goto(hash);
  return { context, page };
}

const RTL_PROJECT = { direction: "rtl" } as const;
const V = `${RTL_FIXTURE.book}/${RTL_FIXTURE.chapter}/${RTL_FIXTURE.verse}`;
const NOTE_V = `${RTL_FIXTURE.book}/${RTL_FIXTURE.chapter}/${RTL_FIXTURE.noteVerse}`;

// A distinctive English substring from the UST of the fixture verse, captured
// from the seeded server so the `ltr` locator never hard-codes sample text that
// a future re-import could change.
async function ustSnippet(): Promise<string> {
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const auth = await mintToken(probe, "rtl-probe");
  const chap = await fetchChapter(probe, auth.token, RTL_FIXTURE.book, RTL_FIXTURE.chapter);
  // fetchChapter's typed payload omits verses; read it off the raw shape.
  const ust = (chap as unknown as {
    verses?: Record<string, Record<string, { plain_text?: string }>>;
  }).verses?.UST?.[String(RTL_FIXTURE.verse)]?.plain_text;
  await probe.dispose();
  expect(ust, "expected an English UST plain_text for the fixture verse").toBeTruthy();
  // First ~6 words — long enough to be unique to this lane, short enough to
  // survive a highlight split within the lane span.
  return ust!.split(/\s+/).slice(0, 6).join(" ");
}

test.describe("RTL text direction on scripture surfaces (#293)", () => {
  // ── Surface 1: flows notes lanes (#/notes) — the PR #292 surface ──────────
  test("flows notes: Arabic lane is rtl, English lane is ltr", async ({ browser }) => {
    const english = await ustSnippet();
    const { context } = await newUserContext(browser, "rtl-notes");
    const page = await context.newPage();
    await page.goto(
      `/#/notes/${RTL_FIXTURE.book}/${RTL_FIXTURE.chapter}/${RTL_FIXTURE.verse}`,
    );

    const arabicLane = page
      .locator('span[dir="auto"]')
      .filter({ hasText: RTL_FIXTURE.arabicUlt });
    await expect(arabicLane).toBeVisible({ timeout: 15_000 });
    expect(await computedDirection(arabicLane)).toBe("rtl");
    await expectRtlPaint(arabicLane, "flows notes lane", { latin: RTL_FIXTURE.latin });

    const englishLane = page.locator('span[dir="auto"]').filter({ hasText: english });
    await expect(englishLane.first()).toBeVisible();
    expect(await computedDirection(englishLane.first())).toBe("ltr");

    await context.close();
  });

  // ── Surface 2: flows questions lanes (#/questions) — the PR #292 surface ───
  test("flows questions: Arabic lane is rtl, English lane is ltr", async ({ browser }) => {
    const english = await ustSnippet();
    const { context } = await newUserContext(browser, "rtl-questions");
    const page = await context.newPage();
    await page.goto(`/#/questions/${RTL_FIXTURE.book}/${RTL_FIXTURE.chapter}`);

    const arabicLane = page
      .locator('span[dir="auto"]')
      .filter({ hasText: RTL_FIXTURE.arabicUlt });
    await expect(arabicLane).toBeVisible({ timeout: 15_000 });
    expect(await computedDirection(arabicLane)).toBe("rtl");
    await expectRtlPaint(arabicLane, "flows questions lane", { latin: RTL_FIXTURE.latin });

    const englishLane = page.locator('span[dir="auto"]').filter({ hasText: english });
    await expect(englishLane.first()).toBeVisible();
    expect(await computedDirection(englishLane.first())).toBe("ltr");

    await context.close();
  });

  // ── Surface 3: classic scripture pane (#/BOOK/CHAPTER) ─────────────────────
  test("classic scripture pane: Hebrew source is rtl, English is ltr", async ({ browser }) => {
    const { context } = await newUserContext(browser, "rtl-classic");
    const page = await context.newPage();
    await page.goto(`/#/${RTL_FIXTURE.book}/1`);

    // The Hebrew original renders RTL by script (versionIsRtl("UHB") === true),
    // independent of the LTR project direction.
    expect(await cellDirection(page, 1, 1, "UHB")).toBe("rtl");
    // An English target pane stays LTR under the default LTR project.
    expect(await cellDirection(page, 1, 1, "UST")).toBe("ltr");

    await context.close();
  });

  // ── Surface 4: classic book view (BookView, whole-book multi-version) ───────
  // BookView is the classic Shell's "book" scripture mode, not a route — it's
  // selected via localStorage (be:scriptureMode), and its visible columns come
  // from be:enabledVersions (default ["ULT","UST"], no source). Seed both before
  // first paint so the whole-book grid renders the Hebrew UHB column too. It is
  // separate rendering code from ScriptureColumn, so it needs its own guard.
  test("book view: Hebrew source is rtl, English is ltr", async ({ browser }) => {
    const { context } = await newUserContext(browser, "rtl-book");
    await context.addInitScript(() => {
      try {
        localStorage.setItem("be:scriptureMode", JSON.stringify("book"));
        localStorage.setItem("be:enabledVersions", JSON.stringify(["UHB", "ULT", "UST"]));
      } catch {
        /* private mode etc. */
      }
    });
    const page = await context.newPage();
    await page.goto(`/#/${RTL_FIXTURE.book}/1`);

    // Assert on chapter 1 verse 1 — the top of the book, loaded immediately
    // (BookView lazy-loads later chapters via IntersectionObserver).
    expect(await cellDirection(page, 1, 1, "UHB")).toBe("rtl");
    expect(await cellDirection(page, 1, 1, "UST")).toBe("ltr");

    await context.close();
  });
});

// ── #486: every remaining surface that shows Arabic, asserting paint ─────────
test.describe("RTL paint on Arabic surfaces (#486)", () => {
  // ── Scripture content: Arabic ULT ZEC 6:1 ─────────────────────────────────

  test("flows verse screen (Read mode): Arabic literal lane paints rtl", async ({ browser }) => {
    const { context, page } = await open(browser, "rtl-verse", `/#/verse/${V}`, {
      project: RTL_PROJECT,
      viewport: { width: 1280, height: 900 },
    });
    await expectRtlSentence(sentence(page.locator("main"), RTL_FIXTURE.arabicUlt), "VerseScreen literal lane");
    await context.close();
  });

  test("translate scripture screen: verse list snippet paints rtl, ULT editor is rtl", async ({
    browser,
  }) => {
    const { context, page } = await open(browser, "rtl-tscripture", `/#/scripture/${V}`, {
      project: RTL_PROJECT,
      viewport: { width: 1280, height: 900 },
    });
    // The verse-list snippet (plain_text, dir="auto").
    await expectRtlSentence(sentence(page, RTL_FIXTURE.arabicUlt), "TranslateScripture verse snippet");
    // The ULT lane editor is a textarea (content_json): a Range cannot measure
    // a form control's value, so this one is computed direction only.
    const editor = page.locator('section[aria-label="ULT lane"] textarea').first();
    await expect(editor).toHaveValue(RTL_FIXTURE.arabicUlt, { timeout: 15_000 });
    expect(await computedDirection(editor)).toBe("rtl");
    await context.close();
  });

  test("translate alignment screen: verse list snippet paints rtl", async ({ browser }) => {
    // dir="auto" follows the content — no project switch needed.
    const { context, page } = await open(browser, "rtl-talign", `/#/alignment/${V}`, {
      viewport: { width: 1280, height: 900 },
    });
    await expectRtlSentence(sentence(page, RTL_FIXTURE.arabicUlt), "TranslateAlign verse snippet");
    await context.close();
  });

  test("tap aligner (phone): Arabic target words run right-to-left", async ({ browser }) => {
    const { context, page } = await open(browser, "rtl-tapalign", `/#/alignment/${V}`, {
      project: RTL_PROJECT,
      viewport: { width: 390, height: 844 },
    });
    const pool = page.locator('[role="list"][aria-label]').filter({ hasText: ULT_WORDS[0] }).last();
    await expect(pool).toBeVisible({ timeout: 15_000 });
    expect(await computedDirection(pool)).toBe("rtl");
    await expectRtlWordOrder(pool, "AlignTapView target pool");
    await context.close();
  });

  // KNOWN BUG (#532): AlignmentPanel's word-bank strip sets no `dir` and
  // its group target stacks hardcode dir="ltr", so under an RTL target project
  // with an LTR UI the Arabic words lay out left-to-right — the sentence reads
  // backwards. Remove `.fail` once fixed.
  test.fail("drag aligner (desktop): Arabic word bank runs right-to-left", async ({ browser }) => {
    const { context, page } = await open(browser, "rtl-dragalign", `/#/alignment/${V}`, {
      project: RTL_PROJECT,
      viewport: { width: 1280, height: 900 },
    });
    await expectRtlWordOrder(page.locator("body"), "AlignmentPanel word bank");
    await context.close();
  });

  test("classic scripture pane: active Arabic ULT verse paints rtl", async ({ browser }) => {
    const { context, page } = await open(browser, "rtl-classic-ar", `/#/${V}`, {
      project: RTL_PROJECT,
      viewport: { width: 1280, height: 900 },
    });
    const cell = page.locator(`[data-find-cell="${RTL_FIXTURE.chapter}-${RTL_FIXTURE.verse}-ULT"]`).first();
    await expectRtlSentence(sentence(cell, RTL_FIXTURE.arabicUlt), "ScriptureColumn active ULT verse");
    await context.close();
  });

  test("classic columns view (DocColumn): Arabic ULT verse paints rtl", async ({ browser }) => {
    const { context, page } = await open(browser, "rtl-doccol", `/#/${V}`, {
      project: RTL_PROJECT,
      storage: { "be:scriptureMode": "columns" },
      viewport: { width: 1280, height: 900 },
    });
    const cell = page.locator(`[data-find-cell="${RTL_FIXTURE.chapter}-${RTL_FIXTURE.verse}-ULT"]`).first();
    await expectRtlSentence(sentence(cell, RTL_FIXTURE.arabicUlt), "DocColumn ULT verse");
    await context.close();
  });

  test("classic book view: Arabic ULT verse paints rtl", async ({ browser }) => {
    const { context, page } = await open(browser, "rtl-book-ar", `/#/${V}`, {
      project: RTL_PROJECT,
      storage: { "be:scriptureMode": "book", "be:enabledVersions": ["ULT", "UST"] },
      viewport: { width: 1280, height: 900 },
    });
    const cell = page.locator(`[data-find-cell="${RTL_FIXTURE.chapter}-${RTL_FIXTURE.verse}-ULT"]`).first();
    await cell.scrollIntoViewIfNeeded({ timeout: 15_000 });
    await expectRtlSentence(sentence(cell, RTL_FIXTURE.arabicUlt), "BookView ULT verse");
    await context.close();
  });

  // #451 (open, needs a product decision): versionIsRtl(null, "ULT") is false,
  // so while /api/project-config has not answered (first load, or offline with
  // nothing cached) VerseScreen paints an Arabic target lane LTR. Hold the
  // config request open and look at the lane in that window. Correct behavior is
  // EITHER not drawing the lane until the direction is known (#451 option A) OR
  // drawing it RTL — so the assertion accepts both, and only an LTR-painted
  // Arabic lane fails. Remove `.fail` once #451 ships.
  test.fail("#451: Arabic lane is not painted LTR while project config is unresolved", async ({
    browser,
  }) => {
    const { context } = await newUserContext(browser, "rtl-451");
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await blockDoor43(page);
    // Never answer: the screen stays in its config-null state.
    await page.route("**/api/project-config", () => {});
    await page.goto(`/#/verse/${V}`);
    // The original-language words render regardless of config — once they are
    // up, the lanes have had their chance to draw.
    await expect(page.locator("[data-original-word]").first()).toBeVisible({ timeout: 15_000 });
    const lane = sentence(page.locator("main"), RTL_FIXTURE.arabicUlt);
    if ((await lane.count()) > 0 && (await lane.isVisible())) {
      await expectRtlPaint(lane, "#451 VerseScreen lane, config pending", { latin: RTL_FIXTURE.latin });
    }
    await context.close();
  });

  // KNOWN BUG (#533): WordsScreen's "In target (ULT)" context and its
  // phone "This verse" drawer set no `dir`, so the Arabic verse inherits the
  // LTR UI and paints with the period on the right. Remove `.fail` once fixed.
  test.fail("words screen: Arabic ULT verse context paints rtl", async ({ browser }) => {
    const { context, page } = await open(browser, "rtl-words", `/#/words/${V}`, {
      project: RTL_PROJECT,
      viewport: { width: 1280, height: 900 },
    });
    // The fixture verse is unaligned, so "In target (ULT)" falls back to the
    // verse's plain_text followed by an English "no milestone match" hint.
    const ctx = containing(page, RTL_FIXTURE.arabicUlt);
    await expectRtlSentence(ctx, "WordsScreen target context", RTL_FIXTURE.arabicUlt);
    await context.close();
  });

  // KNOWN BUG (#533): ReviewContextPanel's ULT/UST lanes set no `dir`,
  // so the Arabic verse inherits the LTR UI (period on the right). Remove
  // `.fail` once fixed.
  test.fail("review queue: Arabic ULT context lane paints rtl", async ({ browser }) => {
    const { context, page } = await open(
      browser,
      "rtl-review",
      `/#/review/${RTL_FIXTURE.book}/${RTL_FIXTURE.chapter}`,
      { project: RTL_PROJECT, viewport: { width: 1280, height: 900 } },
    );
    // The queue opens on the chapter intro; pick the first ZEC 6:1 card so the
    // "This verse" panel shows the fixture verse.
    const ref = `${RTL_FIXTURE.book} ${RTL_FIXTURE.chapter}:${RTL_FIXTURE.verse}`;
    await page.getByText(ref, { exact: true }).first().click({ timeout: 15_000 });
    const lane = containing(page, RTL_FIXTURE.arabicUlt);
    await expectRtlSentence(lane, "ReviewContextPanel ULT lane", RTL_FIXTURE.arabicUlt);
    await context.close();
  });

  // ── Note content: Arabic tn note on ZEC 6:11 ─────────────────────────────

  test("flows notes screen: Arabic note body and list preview paint rtl", async ({ browser }) => {
    const { context, page } = await open(
      browser,
      "rtl-notes-note",
      `/#/notes/${NOTE_V}?row=${RTL_FIXTURE.noteId}`,
      { viewport: { width: 1280, height: 900 } },
    );
    const hits = page.getByText(RTL_FIXTURE.arabicNote, { exact: true });
    await expect(hits.first()).toBeVisible({ timeout: 15_000 });
    const n = await hits.count();
    expect(n, "expected the note body AND its list preview").toBeGreaterThanOrEqual(2);
    for (let i = 0; i < n; i++) {
      if (!(await hits.nth(i).isVisible())) continue;
      await expectRtlSentence(hits.nth(i), `TranslateNotes note #${i}`);
    }
    await context.close();
  });

  test("flows verse screen: Arabic note row and detail pane paint rtl", async ({ browser }) => {
    const { context, page } = await open(browser, "rtl-verse-note", `/#/verse/${NOTE_V}`, {
      viewport: { width: 1280, height: 900 },
    });
    const row = page.locator("[data-resource-row]").filter({ hasText: RTL_FIXTURE.arabicNote }).first();
    await expectRtlSentence(sentence(row, RTL_FIXTURE.arabicNote), "VerseScreen resource row");
    await row.click();
    const detail = page.locator('aside[aria-label="Detail"]');
    await expectRtlSentence(sentence(detail, RTL_FIXTURE.arabicNote), "VerseDetailPane note body");
    await context.close();
  });

  test("classic note card (translation mode): Arabic note editor is rtl", async ({ browser }) => {
    const { context, page } = await open(browser, "rtl-notecard", `/#/${NOTE_V}`, {
      project: { direction: "rtl", mode: "translation" },
      viewport: { width: 1280, height: 900 },
    });
    // NoteCard's note is a textarea: computed direction only (see header).
    const editor = page
      .locator(`[data-note-id="${RTL_FIXTURE.noteId}"] textarea`)
      .filter({ hasText: RTL_FIXTURE.arabicNote })
      .first();
    await expect(editor).toBeVisible({ timeout: 15_000 });
    expect(await computedDirection(editor)).toBe("rtl");
    await context.close();
  });

  // ── Arabic UI chrome (be:uiLang = "ar") ─────────────────────────────────

  test("home (Arabic UI): queue card description paints rtl", async ({ browser }) => {
    const { context, page } = await open(browser, "rtl-home", "/#/home", {
      uiLang: "ar",
      viewport: { width: 1280, height: 900 },
    });
    // "من ULT إلى GLT (حرفية) ومن UST إلى GST (مبسّطة)، آية بآية." — Latin tokens + final period.
    const desc = sentence(page, arUi("flowHome.descScripture"));
    await expect(desc).toBeVisible({ timeout: 15_000 });
    expect(await computedDirection(desc)).toBe("rtl");
    await expectRtlPaint(desc, "HomeScreen descScripture", { latin: "GLT" });
    await context.close();
  });

  test("admin desk (Arabic UI): page subtitles paint rtl", async ({ browser }) => {
    const { context, page } = await open(browser, "dev", "/#/admin/team", {
      uiLang: "ar",
      viewport: { width: 1280, height: 900 },
    });
    // "مَن له وصول هنا، ومن أين يأتي دوره، وكيف تتقدم فرق Door43 على غيرها."
    const team = sentence(page, arUi("adminPages.team.subtitle"));
    await expect(team).toBeVisible({ timeout: 15_000 });
    expect(await computedDirection(team)).toBe("rtl");
    await expectRtlPaint(team, "AdminTeamScreen subtitle", { latin: "Door43" });

    await page.goto("/#/admin/setup");
    const setup = sentence(page, arUi("adminPages.setup.subtitle"));
    await expect(setup).toBeVisible({ timeout: 15_000 });
    expect(await computedDirection(setup)).toBe("rtl");
    await expectRtlPaint(setup, "AdminSetupScreen subtitle");
    await context.close();
  });
});
