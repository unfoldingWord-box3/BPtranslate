// Dev launcher for the onboarding/translate smoke suite (tests/smoke/). Mirrors
// scripts/dev.mjs's process-tree teardown but is otherwise simpler: fixed ports
// (8797 api / 5175 web, both distinct from the concurrency suite's 8787/5173 so
// the two suites never collide) and a short --persist-to directory to dodge
// Windows MAX_PATH failures in deep worktree paths (see STATE.md
// reference-wrangler-worktree-path-length). The stub translate server (port
// 8799) is launched separately by playwright.smoke.config.ts's webServer array.
//
// The empty-DB wipe + migration lives HERE, not in tests/smoke/global-setup.ts,
// despite that file's docstring describing the contract — confirmed via
// Playwright's own runner (createGlobalSetupTasks in
// node_modules/playwright/lib/runner/index.js): plugin setup (which includes
// this script, run as a webServer command, waited on until its readiness URL
// responds) executes BEFORE the config's globalSetup file, not after. By the
// time global-setup.ts would run, `wrangler dev` already holds the persist-to
// SQLite file open for the rest of the suite, so a directory delete there
// EPERMs every time (observed empirically, not just in theory — see the smoke
// suite's PR description). Doing the wipe before spawning wrangler is the only
// ordering that actually works.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const persistTo = process.env.SMOKE_PERSIST || "C:/be-smoke";
const apiDir = path.join(repoRoot, "api");

// wrangler.toml's [assets] block points at ../web/dist unconditionally (dev
// and prod alike) — `wrangler dev` hard-errors at startup if that directory
// doesn't exist. A fresh checkout/worktree has never run a build, so build it
// once here rather than requiring a manual `npm run build` before the very
// first `npm run test:smoke`.
if (!existsSync(path.join(repoRoot, "web", "dist"))) {
  console.log("[dev-smoke] web/dist missing — building once before wrangler dev can start…");
  const build = spawnSync("npm", ["run", "build:web"], { cwd: repoRoot, stdio: "inherit", shell: true });
  if (build.status !== 0) {
    console.error("[dev-smoke] build:web failed — aborting.");
    process.exit(build.status ?? 1);
  }
}

// Back-to-back runs (idempotence) can start before the PRIOR run's native
// workerd child has fully released its lock on the persist-to SQLite file —
// port-free doesn't imply file-handle-free. Retry both the wipe and the
// migrate with backoff rather than letting a one-beat race fail the whole run
// (observed: a second consecutive run crashed wrangler's migrate CLI outright
// when it raced a still-closing prior instance).
function runWithRetry(label, fn, attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return fn();
    } catch (e) {
      if (i === attempts) throw e;
      console.log(`[dev-smoke] ${label} failed (attempt ${i}/${attempts}: ${e}); retrying…`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
}

console.log(`[dev-smoke] wiping ${persistTo} for a truly empty D1…`);
runWithRetry("rmSync", () => rmSync(persistTo, { recursive: true, force: true }));

console.log("[dev-smoke] applying migrations to the fresh local D1…");
runWithRetry("migrations apply", () => {
  const migrate = spawnSync(
    "npx",
    ["wrangler", "d1", "migrations", "apply", "bptranslate_dev", "--local", "--persist-to", persistTo],
    { cwd: apiDir, stdio: "inherit", shell: true },
  );
  if (migrate.status !== 0) {
    throw new Error(`migrations apply exited with status ${migrate.status}`);
  }
});

const spawnOpts = { cwd: apiDir, stdio: "inherit", shell: true };

const api = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "--port",
    "8797",
    "--ip",
    "127.0.0.1",
    "--persist-to",
    persistTo,
    "--var",
    "PIPELINE_API_BASE:http://127.0.0.1:8799",
    "--var",
    "BT_API_TOKEN:smoke-stub",
    // The translate-apply path pins bot rawUrls to DCS_BASE_URL's origin
    // (api/src/rawUrlPin.ts, anti-SSRF). Pointing DCS_BASE_URL at the stub's
    // own origin makes its TSV rawUrls same-origin and pass the pin; the stub
    // reverse-proxies everything else (org manifests, book raw files, etc.)
    // to the real git.door43.org so org detect / book import stay real.
    "--var",
    "DCS_BASE_URL:http://127.0.0.1:8799",
    // Translate jobs run only on the org's own AI key (#551), so the spec saves
    // a dummy one, which needs a wrapping key. A throwaway generated per run
    // (the D1 above is wiped every run, so nothing outlives it); never a real
    // secret. Overrides whatever api/.dev.vars has.
    "--var",
    `AI_KEY_WRAPPING_KEY:${randomBytes(32).toString("base64")}`,
  ],
  spawnOpts,
);
const web = spawn("npm", ["--workspace", "web", "run", "dev", "--", "--port", "5175", "--strictPort"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, VITE_API_PROXY: "http://127.0.0.1:8797" },
});

// child.kill() only signals the top process — on Windows that's the cmd.exe
// shell (shell: true), leaving the real workerd/vite alive still holding the
// port. Tear down the whole tree so a re-run doesn't collide with orphans.
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
