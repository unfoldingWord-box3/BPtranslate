import { test as setup, expect, request as pwRequest } from "@playwright/test";
import { mintToken } from "../concurrency/helpers";
import { GUIDE_BOOK, WORKSPACES } from "./target";

// Playwright "setup" project (the capture project depends on it). Onboards and
// imports every workspace in target.ts through the same API calls the app makes:
// switch workspace -> PUT /api/project-config (Setup wizard Apply) ->
// POST /api/books/:book/import (Books screen "Bring in") -> populate tW/tA
// articles. Every step asserts, so a failed onboarding or import fails the run
// instead of letting the captures show an empty or quarantined project.

setup.describe.configure({ mode: "serial" });
setup.setTimeout(600_000);

for (const [lang, ws] of Object.entries(WORKSPACES)) {
  setup(`onboard + import ${GUIDE_BOOK} into ${ws.slug} (${lang})`, async ({ baseURL }) => {
    const ctx = await pwRequest.newContext({ baseURL });
    try {
      await mintToken(ctx, "dev");
      const csrf = async () => {
        const { cookies } = await ctx.storageState();
        return cookies.find((c) => c.name === "be_csrf")?.value ?? "";
      };
      const write = async (method: "POST" | "PUT", path: string, data?: unknown, timeout = 120_000) =>
        ctx.fetch(path, {
          method,
          headers: { "x-csrf-token": await csrf(), "Content-Type": "application/json" },
          data: data ?? {},
          timeout,
        });

      // 1. Switch to the workspace (sets be_ws and re-mints the access cookie).
      const sw = await write("POST", `/api/workspaces/${ws.slug}`);
      expect(sw.ok(), `switch workspace ${ws.slug}: ${sw.status()} ${await sw.text()}`).toBeTruthy();

      // 2. Onboarding: apply the project preset.
      const put = await write("PUT", "/api/project-config", { preset: ws.preset });
      expect(put.ok(), `apply preset ${ws.preset}: ${put.status()} ${await put.text()}`).toBeTruthy();
      const cfg = (await put.json()) as { config: { preset: string; mode?: string } };
      expect(cfg.config.preset).toBe(ws.preset);
      expect(cfg.config.mode ?? "translation", "guide workspaces must be translation-mode").toBe("translation");

      // 3. Import the book.
      const imp = await write(
        "POST",
        `/api/books/${GUIDE_BOOK}/import`,
        ws.translateFromSource ? { translateFromSource: true } : {},
      );
      expect(imp.ok(), `import ${GUIDE_BOOK} into ${ws.slug}: ${imp.status()} ${await imp.text()}`).toBeTruthy();

      // 4. Populate tW / tA articles for the Words screens.
      let done = false;
      for (let round = 0; round < 80 && !done; round++) {
        const r = await write("POST", "/api/articles/populate", { book: GUIDE_BOOK });
        expect(r.ok(), `populate articles: ${r.status()} ${await r.text()}`).toBeTruthy();
        const b = (await r.json()) as { skipped?: boolean; aborted?: boolean; remaining?: number };
        done = !!(b.skipped || b.aborted || b.remaining === 0);
      }
      expect(done, "article populate did not finish").toBeTruthy();

      // 5. The project must hold real content: notes, questions, scripture.
      const chRes = await ctx.get(`/api/chapters/${GUIDE_BOOK}/1`);
      expect(chRes.ok(), `GET chapter: ${chRes.status()}`).toBeTruthy();
      const ch = (await chRes.json()) as {
        tn: unknown[];
        tq: unknown[];
        twl: unknown[];
        verses?: Record<string, Record<string, unknown> | undefined>;
      };
      expect(ch.tn.length, `${ws.slug}: no tn rows for ${GUIDE_BOOK} 1`).toBeGreaterThan(0);
      expect(ch.tq.length, `${ws.slug}: no tq rows for ${GUIDE_BOOK} 1`).toBeGreaterThan(0);
      expect(ch.twl.length, `${ws.slug}: no twl rows for ${GUIDE_BOOK} 1`).toBeGreaterThan(0);
      for (const key of ["UHB", "ULT", "UST"]) {
        expect(
          Object.keys(ch.verses?.[key] ?? {}).length,
          `${ws.slug}: no ${key} verses (empty or quarantined lane)`,
        ).toBeGreaterThan(0);
      }
    } finally {
      await ctx.dispose();
    }
  });
}
