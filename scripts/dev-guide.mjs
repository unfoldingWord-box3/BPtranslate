// Dev launcher for the guide screenshot rig (playwright.guide.config.ts,
// tests/guide/capture.spec.ts). Modeled on scripts/dev-smoke.mjs: wipe a
// private local D1, migrate, seed ZEC + the en-unfoldingword project config
// (same statements as tests/concurrency/global-setup.ts, minus the Arabic RTL
// fixture rows so screenshots show the real sample text), then run wrangler +
// vite on their own ports. The wipe/seed happens here, before wrangler starts,
// for the same reason as dev-smoke (Playwright runs webServer before globalSetup).
// Ports: GUIDE_API_PORT (8807) / GUIDE_WEB_PORT (5185). State lives inside the
// checkout (.wrangler/guide-state, gitignored) so deep worktree paths and
// concurrent suites never collide.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = path.join(repoRoot, "api");
const apiPort = Number(process.env.GUIDE_API_PORT || 8807);
const webPort = Number(process.env.GUIDE_WEB_PORT || 5185);
const persistTo = path.join(repoRoot, ".wrangler", "guide-state");

function run(label, cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`[dev-guide] ${label} failed (status ${r.status}) — aborting.`);
    process.exit(r.status ?? 1);
  }
}

if (!existsSync(path.join(repoRoot, "web", "dist"))) {
  console.log("[dev-guide] web/dist missing — building once…");
  run("build:web", "npm", ["run", "build:web"], repoRoot);
}

console.log(`[dev-guide] wiping ${persistTo}…`);
rmSync(persistTo, { recursive: true, force: true });
mkdirSync(persistTo, { recursive: true });

const d1 = (extra) => ["wrangler", "d1", ...extra, "--local", "--persist-to", JSON.stringify(persistTo)];
console.log("[dev-guide] applying migrations…");
run("migrations apply", "npx", d1(["migrations", "apply", "bptranslate_dev"]), apiDir);

const sqlPath = path.join(repoRoot, "scripts", "out", "import-ZEC.sql");
if (!existsSync(sqlPath)) {
  console.log("[dev-guide] generating ZEC import SQL…");
  run("import-book", "node", ["scripts/import-book.mjs", "ZEC"], repoRoot);
}
console.log("[dev-guide] importing ZEC…");
run("ZEC import", "npx", d1(["execute", "bptranslate_dev", `--file=${JSON.stringify(sqlPath)}`]), apiDir);

// Pin the workspace to en-unfoldingword (otherwise the ar-bsoj preset
// quarantines the ULT/UST lanes) — see tests/concurrency/global-setup.ts.
const seedPath = path.join(persistTo, "seed-project-config.sql");
writeFileSync(
  seedPath,
  `INSERT INTO project_config (id, preset, overrides_json, updated_at) ` +
    `VALUES (1, 'en-unfoldingword', NULL, unixepoch()) ` +
    `ON CONFLICT(id) DO UPDATE SET preset = 'en-unfoldingword', overrides_json = NULL, updated_at = unixepoch();\n` +
    `DELETE FROM scripture_lane_state WHERE lane IN ('lit', 'sim');\n`,
);
console.log("[dev-guide] seeding project config…");
run("project config seed", "npx", d1(["execute", "bptranslate_dev", `--file=${JSON.stringify(seedPath)}`]), apiDir);

const spawnOpts = { cwd: apiDir, stdio: "inherit", shell: true };
const api = spawn(
  "npx",
  [
    "wrangler", "dev",
    "--port", String(apiPort),
    "--inspector-port", String(apiPort + 1000),
    "--ip", "127.0.0.1",
    "--persist-to", JSON.stringify(persistTo),
  ],
  spawnOpts,
);
const web = spawn("npm", ["--workspace", "web", "run", "dev", "--", "--port", String(webPort), "--strictPort"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, VITE_API_PROXY: `http://127.0.0.1:${apiPort}` },
});

function killTree(child) {
  if (!child.pid || child.killed) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill();
  }
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  killTree(api);
  killTree(web);
  process.exit(code ?? 0);
}
api.on("exit", (code) => shutdown(code ?? 0));
web.on("exit", (code) => shutdown(code ?? 0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
