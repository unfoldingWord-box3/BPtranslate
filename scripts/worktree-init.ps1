# Install dependencies for a fresh worktree so it is fully self-contained.
# Run from the worktree root after `git worktree add`. Idempotent.
#
# WHY A REAL INSTALL (not junctions): earlier versions junctioned node_modules
# from the main checkout to skip `npm install`. That was a Windows footgun --
# a recursive delete of a worktree (rm -rf / Remove-Item -Recurse / git
# worktree remove --force) FOLLOWS the junction and wipes MAIN's node_modules,
# and via npm's node_modules/@bible-editor workspace links, MAIN's web/ and
# api/ SOURCE too. That wiped the main checkout repeatedly. A real per-worktree
# install carries no path back into main, so a worktree delete can only ever
# touch its own files. Cost is ~314 MB/worktree; the shared npm cache makes the
# install a fast local unpack, not a network download.
#
# Teardown: use scripts/worktree-cleanup.ps1 (it unlinks any leftover junctions
# before deleting). Never `rm -rf` / `Remove-Item -Recurse` a worktree by hand.

$ErrorActionPreference = "Stop"

$gitCommon = (git rev-parse --git-common-dir).Trim()
$mainRoot  = (Resolve-Path (Join-Path $gitCommon "..")).Path
$worktreeRoot = (Get-Location).Path

if ($mainRoot -eq $worktreeRoot) {
    Write-Host "Already in the main checkout - nothing to init."
    exit 0
}

# If a previous (junction-based) init left node_modules junctions pointing at
# main, unlink them (link only, never the target) before installing real deps.
$legacy = @("node_modules", "web\node_modules", "api\node_modules")
foreach ($t in $legacy) {
    $p = Join-Path $worktreeRoot $t
    if (Test-Path $p) {
        $item = Get-Item $p -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            [System.IO.Directory]::Delete($p, $false)   # unlink only
            Write-Host "unlinked legacy junction: $t"
        }
    }
}

# Copy api/.dev.vars from the main checkout. It's gitignored, so a fresh
# worktree lacks it — without it `wrangler dev` has no JWT_SIGNING_KEY (auth
# 500s) and no SUPER_ADMINS=dev (workspace switching silently 403s; the toml
# default is deliberately empty because it deploys to the public dev worker).
$devVarsSrc = Join-Path $mainRoot "api\.dev.vars"
$devVarsDst = Join-Path $worktreeRoot "api\.dev.vars"
if ((Test-Path $devVarsSrc) -and -not (Test-Path $devVarsDst)) {
    Copy-Item $devVarsSrc $devVarsDst
    Write-Host "copied api/.dev.vars from main checkout"
}

# Step 2: install dependencies if absent.
if (Test-Path (Join-Path $worktreeRoot "node_modules")) {
    Write-Host "node_modules already present (real install) - skipping. Delete it to force a reinstall."
} else {
    Write-Host "Installing dependencies (npm install) in $worktreeRoot ..."
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
    Write-Host "Worktree ready - self-contained node_modules, no junction to main."
}

# Step 3: build web/dist if absent. api/wrangler.toml's [assets] directory is
# "../web/dist"; `wrangler dev` exits at once when it's missing, so `npm run dev`
# fails and Vite is left orphaned on :5173.
if (Test-Path (Join-Path $worktreeRoot "web\dist")) {
    Write-Host "web/dist already present - skipping build."
} else {
    Write-Host "Building web/dist (npm run build:web) ..."
    npm run build:web
    if ($LASTEXITCODE -ne 0) { throw "npm run build:web failed (exit $LASTEXITCODE)" }
}

# Step 4: apply local D1 migrations. Without them the local SQLite has no schema
# and `POST /api/auth/dev` 500s with "no such table: users". `migrations apply`
# is idempotent (applies only unapplied migrations), so it is safe to run every
# time; answer its prompt non-interactively.
Write-Host "Applying local D1 migrations (bptranslate_dev) ..."
Push-Location (Join-Path $worktreeRoot "api")
try {
    "y" | npx wrangler d1 migrations apply bptranslate_dev --local
    if ($LASTEXITCODE -ne 0) { throw "d1 migrations apply failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}
Write-Host "Worktree init complete."
