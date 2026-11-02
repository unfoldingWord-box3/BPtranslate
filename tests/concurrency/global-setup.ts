import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Synthetic RTL fixture for the direction-guard spec (rtl-direction.spec.ts,
// issues #293 and #486). The seed applied in globalSetup below pins the
// workspace to the `en-unfoldingword` preset (so the ULT/UST scripture lanes are
// actually served — see the seed comment), overwrites ONE ZEC verse's ULT text
// with the Arabic sentence here so the scripture surfaces have real
// right-to-left content while the UST lane stays English (a mixed screen to
// assert both `rtl` and `ltr` on), and overwrites ONE tn note with an Arabic
// sentence for the note surfaces. ZEC 6:1 is chosen for scripture because it
// already carries both a tn note and a tq question in the sample bundle, so both
// flows surfaces have a row to select.
//
// The verse is rewritten in BOTH plain_text and content_json (#486): most
// scripture surfaces (VerseScreen, DocColumn, BookView, the aligners, the
// classic active verse) render from content_json, so an Arabic plain_text alone
// never reaches them. content_json becomes plain unaligned \w words (no
// alignment milestones); no other spec reads ULT alignment at 6:1.
//
// The Arabic note goes on ZEC 6:11, not 6:1, because s1/s2/s5/s6/s7/s8 rewrite
// the ZEC 6:1 notes; no other spec touches 6:11.
//
// Both sentences end in a sentence-final period and embed one Latin token
// ("AVD"), the two things a bidi bug visibly breaks: in RTL the period paints at
// the LEFT end of the line, and the Latin run keeps its own left-to-right letter
// order while sitting in right-to-left word order. rtl-paint.ts measures that.
// The Hebrew UHB original — which the classic + book-view surfaces render RTL by
// script (versionIsRtl) — is left completely alone.
export const RTL_FIXTURE = {
  book: "ZEC",
  chapter: 6,
  verse: 1,
  // "This is Arabic text AVD for testing the text direction." — a distinctive,
  // first-strong-RTL string so `dir="auto"` resolves the lane to rtl.
  arabicUlt: "هَٰذَا نَصٌّ عَرَبِيٌّ AVD لِاخْتِبَارِ ٱتِّجَاهِ ٱلنَّصِّ.",
  // The Latin token embedded in both Arabic sentences.
  latin: "AVD",
  // tn row whose note becomes Arabic: sample row f66i, ZEC 6:11 ("Jehozadak").
  noteId: "f66i",
  noteVerse: 11,
  // "This is the name of a man AVD in the translation."
  arabicNote: "هَٰذَا ٱسْمُ رَجُلٍ AVD فِي ٱلتَّرْجَمَةِ.",
} as const;

/** usfm-js verse object for `text`: unaligned \w words, spaces, a final "." as text. */
function verseObjectsFor(text: string): { verseObjects: unknown[] } {
  const body = text.replace(/\.$/, "");
  const words = body.split(" ");
  const total = new Map<string, number>();
  for (const w of words) total.set(w, (total.get(w) ?? 0) + 1);
  const seen = new Map<string, number>();
  const verseObjects: unknown[] = [];
  words.forEach((w, i) => {
    if (i > 0) verseObjects.push({ type: "text", text: " " });
    const occ = (seen.get(w) ?? 0) + 1;
    seen.set(w, occ);
    verseObjects.push({
      text: w,
      tag: "w",
      type: "word",
      occurrence: String(occ),
      occurrences: String(total.get(w)),
    });
  });
  if (body !== text) verseObjects.push({ type: "text", text: "." });
  return { verseObjects };
}

// Runs once before any test. Re-imports ZEC from docs/samples into the local
// D1 instance so every test starts against a known fixture. We pick ZEC
// because the sample bundle already has its full TN/TQ/TWL/USFM set, and the
// importer is idempotent (REPLACE INTO + DELETE WHERE book='ZEC') so re-runs
// are safe.
//
// The webServer (api + web) is started by Playwright *after* this finishes,
// so we're free to write the SQLite file directly via `wrangler d1 execute`.
export default async function globalSetup() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../..");
  const sqlPath = resolve(repoRoot, "scripts/out/import-ZEC.sql");

  if (!existsSync(sqlPath)) {
    console.log("[setup] generating ZEC import SQL…");
    const gen = spawnSync("node", ["scripts/import-book.mjs", "ZEC"], {
      cwd: repoRoot,
      stdio: "inherit",
      shell: true,
    });
    if (gen.status !== 0) {
      throw new Error(`import-book.mjs ZEC failed with exit ${gen.status}`);
    }
  }

  console.log("[setup] applying ZEC import to local D1…");
  // wrangler d1 execute on Windows needs the .cmd shim; spawnSync with
  // shell:true picks it up automatically and avoids ENOENT.
  const apply = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      // The default (non-production) env's D1 is `bptranslate_dev` since the
      // dev/prod database split — the local SQLite store wrangler dev uses.
      // Seeding `bptranslate` (the prod name) would target the wrong/no DB.
      "bptranslate_dev",
      "--local",
      `--file=${sqlPath}`,
    ],
    {
      cwd: resolve(repoRoot, "api"),
      stdio: "inherit",
      shell: true,
    },
  );
  if (apply.status !== 0) {
    throw new Error(
      `wrangler d1 execute failed (status ${apply.status}). ` +
        "Have migrations been applied? Try `npm --workspace api run db:migrate:local` first.",
    );
  }

  // Seed the synthetic Arabic ULT verse + tn note for the RTL direction guard
  // (#293, #486). Written to a SQL file (rather than passed inline) so the
  // Arabic strings are never split/mangled by the shell. Runs AFTER the ZEC
  // import so it wins.
  console.log("[setup] seeding RTL fixture verse + note…");
  const seedSqlPath = resolve(repoRoot, "scripts/out/seed-rtl-fixture.sql");
  const sq = (v: string) => v.replace(/'/g, "''");
  writeFileSync(
    seedSqlPath,
    // Pin the test workspace to the standard English uW project (the canonical
    // authoring setup for a Hebrew book like ZEC). Without a project_config row
    // the env falls back to the `ar-bsoj` preset, which DELIBERATELY quarantines
    // the ULT/UST lanes (replacement_required) pending an AVD/NAV replacement, so
    // the chapter API serves only the Hebrew UHB and the scripture panes have no
    // target text to assert direction on. `en-unfoldingword` is LTR and does not
    // quarantine — the normal post-setup working state, inert to the note-only
    // specs (which never touch scripture lanes).
    `INSERT INTO project_config (id, preset, overrides_json, updated_at) ` +
      `VALUES (1, 'en-unfoldingword', NULL, unixepoch()) ` +
      `ON CONFLICT(id) DO UPDATE SET preset = 'en-unfoldingword', ` +
      `overrides_json = NULL, updated_at = unixepoch();\n` +
      // Drop any pre-existing lane rows so ensureLaneState recreates them under
      // the en preset with replacement_required = 0 (its INSERT OR IGNORE never
      // resets an existing row, so a stale ar-bsoj-quarantined row would linger).
      `DELETE FROM scripture_lane_state WHERE lane IN ('lit', 'sim');\n` +
      // Overwrite ONE ULT verse with Arabic (plain_text AND content_json) so the
      // scripture surfaces have real RTL content to render, while UST stays
      // English for the `ltr` half.
      `UPDATE verses SET plain_text = '${sq(RTL_FIXTURE.arabicUlt)}', ` +
      `content_json = '${sq(JSON.stringify(verseObjectsFor(RTL_FIXTURE.arabicUlt)))}' ` +
      `WHERE book = '${RTL_FIXTURE.book}' AND chapter = ${RTL_FIXTURE.chapter} ` +
      `AND verse = ${RTL_FIXTURE.verse} AND bible_version = 'ULT';\n` +
      // ...and ONE tn note with Arabic for the note surfaces (#486).
      `UPDATE tn_rows SET note = '${sq(RTL_FIXTURE.arabicNote)}' ` +
      `WHERE book = '${RTL_FIXTURE.book}' AND id = '${RTL_FIXTURE.noteId}';\n`,
  );
  const seed = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "bptranslate_dev", "--local", `--file=${seedSqlPath}`],
    { cwd: resolve(repoRoot, "api"), stdio: "inherit", shell: true },
  );
  if (seed.status !== 0) {
    throw new Error(`RTL fixture seed failed (status ${seed.status}).`);
  }

  // The seed above wrote project_config straight to the local SQLite file. The
  // API caches project config per isolate for 60 s (api/src/projectConfig.ts,
  // CACHE_TTL_MS) and an out-of-band D1 write cannot reach clearProjectConfigCache
  // — so a dev server that is ALREADY running (playwright.config's
  // reuseExistingServer:true, the normal local path) keeps serving the pre-seed
  // config (which falls back to the ar-bsoj preset, quarantining the ULT/UST
  // lanes) for up to a minute after setup. ensureLaneState then recreates lit/sim
  // as replacement_required and the chapter API serves only Hebrew UHB, so
  // rtl-direction.spec fails for most of the run (#317).
  //
  // Fix: after the D1 write, best-effort invalidate the warm isolate's cache
  // THROUGH the API. Playwright's webServer (with its own /api/health check,
  // playwright.config.ts) is already started and healthy by the time globalSetup
  // runs, so there is normally a server to reach here. The call is a cheap,
  // idempotent no-op when there is nothing stale to invalidate — it only does
  // real work in the exact flaky case (a warm isolate serving pre-seed config).
  // The try/catch exists for the rare case where no server is listening at all
  // (e.g. this file invoked outside the normal Playwright run); there the cold
  // cache is correct anyway, since it reads the seeded row on first request.
  await invalidateWarmConfigCache();

  console.log("[setup] complete");
}

// Best-effort: if a dev server is already running, mint a dev JWT and PATCH the
// project mode. That route (applyProjectMode) reads the config row UNCACHED,
// is identity-preserving (never trips the tenancy/lane guards even on a populated
// DB), and — the whole point here — ends by calling clearProjectConfigCache, so
// the warm isolate re-reads our freshly seeded en-unfoldingword row on the next
// request. Any failure (no server, dev auth disabled, non-local host) is
// non-fatal: a cold run needs no invalidation.
async function invalidateWarmConfigCache(): Promise<void> {
  const base = process.env.BE_BASE_URL ?? "http://localhost:5173";
  const withTimeout = (ms: number) => AbortSignal.timeout(ms);
  try {
    const health = await fetch(`${base}/api/health`, { signal: withTimeout(2000) });
    if (!health.ok) return; // no warm server → cold path, nothing cached to bust
  } catch {
    return; // server not up yet (cold run) — expected, not an error
  }

  try {
    // POST /api/auth/dev is CSRF-exempt and mints an admin dev user; the host
    // check accepts localhost/127.0.0.1 (the proxy base above qualifies).
    const mint = await fetch(`${base}/api/auth/dev`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "dev" }),
      signal: withTimeout(5000),
    });
    if (!mint.ok) {
      console.warn(`[setup] warm-cache invalidation skipped: dev auth ${mint.status}`);
      return;
    }
    const jar: Record<string, string> = {};
    for (const sc of mint.headers.getSetCookie()) {
      const pair = sc.split(";", 1)[0];
      const eq = pair.indexOf("=");
      if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    if (!jar.be_csrf) {
      console.warn("[setup] warm-cache invalidation skipped: no be_csrf cookie");
      return;
    }
    const cookie = Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    // Mutating request: echo the double-submit be_csrf value as x-csrf-token.
    const patch = await fetch(`${base}/api/project-config/mode`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": jar.be_csrf },
      body: JSON.stringify({ mode: "authoring" }),
      signal: withTimeout(5000),
    });
    if (patch.ok) {
      console.log("[setup] warm dev server config cache invalidated");
    } else {
      console.warn(`[setup] warm-cache invalidation returned ${patch.status}`);
    }
  } catch (e) {
    console.warn(`[setup] warm-cache invalidation error (non-fatal): ${String(e)}`);
  }
}
