import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mintToken } from "../concurrency/helpers";
// @ts-expect-error — plain .mjs module with no type declarations
import { loadGuide } from "../../scripts/build-help.mjs";

// Captures every `screenshots:` line of every English article, once per
// language folder that exists (see help/README.md). Env GUIDE_ONLY=<id,id>
// limits it to those article ids. The dev user "dev" is auto-granted admin on
// mint (api/src/auth.ts mintDevToken), so admin screens render.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const guide = loadGuide(repoRoot) as Record<string, { id: string; screenshots: { name: string; hash: string; phone: boolean }[] }[]>;
const only = (process.env.GUIDE_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const langs = Object.keys(guide).filter((l) => guide[l].length > 0 || l === "en");

for (const lang of langs) {
  for (const art of guide.en) {
    if (only.length && !only.includes(art.id)) continue;
    for (const shot of art.screenshots) {
      test(`${lang}/${shot.name}`, async ({ browser }) => {
        // newUserContext() takes no viewport options, so build the context here
        // and sign in with the same mintToken() it uses (cookie auth).
        const ctx = await browser.newContext(
          shot.phone
            ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
            : { viewport: { width: 1280, height: 800 } },
        );
        try {
          await mintToken(ctx.request, "dev");
          await ctx.addInitScript((code) => {
            try {
              localStorage.setItem("be:uiLang", code);
            } catch {
              /* ignore */
            }
          }, lang);
          const page = await ctx.newPage();
          await page.goto("/" + shot.hash);
          await page.waitForLoadState("networkidle");
          await page.waitForTimeout(1500);
          const out = resolve(repoRoot, "help", "screenshots", lang, `${shot.name}.png`);
          mkdirSync(dirname(out), { recursive: true });
          await page.screenshot({ path: out, animations: "disabled", caret: "hide" });
        } finally {
          await ctx.close();
        }
      });
    }
  }
}
