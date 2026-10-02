// Dev launcher for the guide screenshot rig (playwright.guide.config.ts,
// tests/guide/seed.setup.ts + capture.spec.ts). Modeled on scripts/dev-smoke.mjs:
// wipe the private local D1s, migrate both dev workspace databases, then run
// wrangler + vite on their own ports. The wipe happens here, before wrangler
// starts, for the same reason as dev-smoke (Playwright runs webServer first).
// Ports: GUIDE_API_PORT (8807) / GUIDE_WEB_PORT (5185). State lives inside the
// checkout (.wrangler/guide-state, gitignored) so deep worktree paths and
// concurrent suites never collide.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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

// The second dev workspace (DB_MLTEST, "mltest") has its own D1.
console.log("[dev-guide] applying migrations to the mltest workspace DB…");
run("mltest migrations apply", "npx", d1(["migrations", "apply", "bptranslate_mltest_dev"]), apiDir);
// Onboarding + book import happen in the Playwright "setup" project
// (tests/guide/seed.setup.ts), through the app's API, once the servers are up.

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
