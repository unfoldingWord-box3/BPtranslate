import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mintToken } from "../concurrency/helpers";
import { workspaceFor } from "./target";
// @ts-expect-error — plain .mjs module with no type declarations
import { loadGuide } from "../../scripts/build-help.mjs";

// Captures every `screenshots:` line of every English article, once per
// language folder that exists (see help/README.md). Each language is captured
// from its own seeded workspace (tests/guide/target.ts, seeded by
// seed.setup.ts). Env GUIDE_ONLY=<id,id> limits it to those article ids. The dev user "dev" is auto-granted admin on
// mint (api/src/auth.ts mintDevToken), so admin screens render.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const guide = loadGuide(repoRoot) as Record<string, { id: string; screenshots: { name: string; hash: string; phone: boolean; top: boolean }[] }[]>;
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
          const auth = await mintToken(ctx.request, "dev");
          // Switch to this language's workspace (sets be_ws, re-mints the access
          // cookie for that workspace's role).
          const ws = workspaceFor(lang);
          const sw = await ctx.request.post(`/api/workspaces/${ws.slug}`, {
            headers: { "x-csrf-token": auth.csrf, "Content-Type": "application/json" },
            data: {},
          });
          if (!sw.ok()) throw new Error(`switch to workspace ${ws.slug}: ${sw.status()} ${await sw.text()}`);
          await ctx.addInitScript(
            ({ code, slug }) => {
              try {
                localStorage.setItem("be:uiLang", code);
                localStorage.setItem("bible-editor.workspace", slug);
              } catch {
                /* ignore */
              }
            },
            { code: lang, slug: ws.slug },
          );
          const page = await ctx.newPage();
          await page.goto("/" + shot.hash);
          await page.waitForLoadState("networkidle");
          // The app's Hebrew stack ("Times New Roman","SBL Hebrew","Cardo") resolves to
          // DejaVu on a bare Linux box, which has no cantillation marks, so UHB shows
          // empty boxes. Map those names, for Hebrew code points only, to Ezra SIL
          // when it is installed (`local()` is a no-op when it is not). The Arabic
          // reading stack ("Source Serif Pro","Cambria","Times New Roman") has the
          // same problem: DejaVu lacks alef wasla (U+0671), which ar_avd uses on
          // nearly every line, so map it to Noto Naskh Arabic (fonts-noto-core).
          // Users' own machines carry fonts that cover both scripts.
          const face = (f: string, src: string, range: string) =>
            `@font-face{font-family:"${f}";src:${src};unicode-range:${range};}`;
          // The flows screens use SCRIPTURE_FONT_STACK (web/src/theme.ts).
          const families = [
            "Times New Roman", "SBL Hebrew", "Cardo", "Source Serif Pro", "Cambria",
            "Iowan Old Style", "Charter", "Palatino Linotype", "Georgia", "Frank Ruhl Libre",
          ];
          await page.addStyleTag({
            content: [
              ...families.map((f) =>
                face(f, 'local("Ezra SIL"),local("EzraSIL")', "U+0590-05FF,U+FB1D-FB4F"),
              ),
              ...families.map((f) =>
                face(f, 'local("Noto Naskh Arabic")', "U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF"),
              ),
            ].join(""),
          });
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(1500);
          if (shot.top) {
            // Some screens open scrolled part-way down: put the page and every
            // scrollable area back at the top.
            await page.evaluate(() => {
              window.scrollTo(0, 0);
              for (const el of Array.from(document.querySelectorAll("*"))) {
                if (el.scrollTop > 0) el.scrollTop = 0;
              }
            });
            await page.waitForTimeout(300);
          }
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
