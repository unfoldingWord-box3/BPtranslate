import { defineConfig, devices } from "@playwright/test";

// Screenshot capture for the in-app guide (`npm run guide:screenshots`).
// Own ports (api 8807 / web 5185, override with GUIDE_API_PORT / GUIDE_WEB_PORT)
// and its own local D1 (.wrangler/guide-state, wiped and seeded with ZEC by
// scripts/dev-guide.mjs). reuseExistingServer is false on purpose: a port
// collision must fail the run rather than capture some other server's app.
const WEB_PORT = Number(process.env.GUIDE_WEB_PORT || 5185);
const BASE_URL = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: "tests/guide",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/dev-guide.mjs",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
