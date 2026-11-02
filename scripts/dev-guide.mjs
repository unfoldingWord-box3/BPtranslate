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

function tryRun(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) throw new Error(`exited with status ${r.status}`);
}

function run(label, cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`[dev-guide] ${label} failed (status ${r.status}) — aborting.`);
    process.exit(r.status ?? 1);
  }
}

function runWithRetry(label, fn, attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return fn();
    } catch (e) {
      if (i === attempts) throw e;
      console.log(`[dev-guide] ${label} failed (attempt ${i}/${attempts}: ${e}); retrying…`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
}

if (!existsSync(path.join(repoRoot, "web", "dist"))) {
  console.log("[dev-guide] web/dist missing — building once…");
  run("build:web", "npm", ["run", "build:web"], repoRoot);
}

// A previous run's workerd may still hold the SQLite file, so retry the wipe.
console.log(`[dev-guide] wiping ${persistTo}…`);
runWithRetry("rmSync", () => rmSync(persistTo, { recursive: true, force: true }));
mkdirSync(persistTo, { recursive: true });

const d1 = (extra) => ["wrangler", "d1", ...extra, "--local", "--persist-to", JSON.stringify(persistTo)];
console.log("[dev-guide] applying migrations…");
runWithRetry("migrations apply", () => tryRun("npx", d1(["migrations", "apply", "bptranslate_dev"]), apiDir));

// The second dev workspace (DB_MLTEST, "mltest") has its own D1.
console.log("[dev-guide] applying migrations to the mltest workspace DB…");
runWithRetry("mltest migrations apply", () => tryRun("npx", d1(["migrations", "apply", "bptranslate_mltest_dev"]), apiDir));
// Onboarding + book import happen in the Playwright "setup" project
// (tests/guide/seed.setup.ts), through the app's API, once the servers are up.

// Own process group on POSIX (detached), so shutdown can signal the whole group:
// with shell: true the child pid is the shell, and killing only it would leave
// wrangler/workerd and vite holding the ports.
const ownGroup = process.platform !== "win32";
const spawnOpts = { cwd: apiDir, stdio: "inherit", shell: true, detached: ownGroup };
const api = spawn(
  "npx",
  [
    "wrangler", "dev",
    "--port", String(apiPort),
    "--inspector-port", String(apiPort + 1000),
    "--ip", "127.0.0.1",
    // Throwaway local value (base64 of 32 bytes) so the admin AI screen shows no "bring your own key" warning.
    "--var", "AI_KEY_WRAPPING_KEY:ZGV2LW9ubHktZ3VpZGUtd3JhcHBpbmcta2V5LTMyYiE=",
    "--persist-to", JSON.stringify(persistTo),
  ],
  spawnOpts,
);
const web = spawn("npm", ["--workspace", "web", "run", "dev", "--", "--port", String(webPort), "--strictPort"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: true,
  detached: ownGroup,
  env: { ...process.env, VITE_API_PROXY: `http://127.0.0.1:${apiPort}` },
});

function killTree(child, signal = "SIGTERM") {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, signal); // the whole group: shell, wrangler/workerd, vite
    } catch {
      /* group already gone */
    }
  }
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  killTree(api);
  killTree(web);
  if (!ownGroup) process.exit(code ?? 0);
  // workerd can ignore SIGTERM; force anything still alive after a grace period.
  setTimeout(() => {
    killTree(api, "SIGKILL");
    killTree(web, "SIGKILL");
    process.exit(code ?? 0);
  }, 2000);
}
api.on("exit", (code) => shutdown(code ?? 0));
web.on("exit", (code) => shutdown(code ?? 0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
