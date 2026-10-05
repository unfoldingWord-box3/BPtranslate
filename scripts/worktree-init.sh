#!/usr/bin/env bash
# Install and prepare a fresh worktree so it is fully self-contained on Linux.
# Run from the worktree root after `git worktree add`. Idempotent — each step
# skips itself when its output already exists.
#
# This is the POSIX-bash companion to scripts/worktree-init.ps1 (the Linux box,
# Ubuntu 26.04, has no pwsh). It does the same work, minus the Windows-only
# junction-unlink block: junctions were a Windows footgun and Linux never made
# them, so `git worktree remove` is safe here with nothing to unlink.
#
# WHY A REAL INSTALL (not links): a per-worktree `npm install` carries no path
# back into main, so a worktree delete can only ever touch its own files. The
# shared npm cache makes it a fast local unpack, not a network download.
#
# A fresh worktree needs five things before `npm run dev` gives a working
# sign-in; this script does 1-4 (5 is best-effort):
#   1. copy api/.dev.vars from main   (JWT_SIGNING_KEY, SUPER_ADMINS=dev)
#      1b. fill an empty AI_KEY_WRAPPING_KEY with a local value (BYO AI keys)
#   2. npm install                   (nothing runs without it)
#   3. build web/dist                 (wrangler dev's [assets] aborts without it)
#   4. apply local D1 migrations      (else POST /api/auth/dev 500s: no such table: users)
#   5. graft build                    (graft-wired repo; regenerable index)
set -euo pipefail

# Resolve the worktree root and the main checkout root. `--git-common-dir`
# points at MAIN's .git (from a worktree it's absolute; from main it's ".git"),
# so its parent is the main checkout. `--show-toplevel` is this worktree's root.
git_common=$(git rev-parse --git-common-dir)
main_root=$(cd "$(dirname "$git_common")" && pwd)
worktree_root=$(git rev-parse --show-toplevel)
cd "$worktree_root"

if [ "$main_root" = "$worktree_root" ]; then
  echo "Already in the main checkout - nothing to init."
  exit 0
fi

# Step 1: copy api/.dev.vars from the main checkout. It's gitignored, so a fresh
# worktree lacks it — without it `wrangler dev` has no JWT_SIGNING_KEY (auth
# 500s) and no SUPER_ADMINS=dev (workspace switching silently 403s; the toml
# default is deliberately empty because it deploys to the public dev worker).
dev_vars_src="$main_root/api/.dev.vars"
dev_vars_dst="$worktree_root/api/.dev.vars"
if [ -f "$dev_vars_src" ] && [ ! -f "$dev_vars_dst" ]; then
  cp "$dev_vars_src" "$dev_vars_dst"
  chmod 600 "$dev_vars_dst"
  echo "copied api/.dev.vars from main checkout"
fi

# Step 1b: give this worktree its own local AI_KEY_WRAPPING_KEY. Main's file and
# .dev.vars.example ship it empty, and empty disables the BYO AI key field on the
# AI service screen, so no key can be saved in local dev. The value is a
# throwaway local one: base64 of 32 random bytes, the format aiKeyCrypto.ts
# requires. Only this worktree's file is written; the early exit above means
# this never runs in the main checkout. A non-empty value is left alone, so a
# re-run keeps any key already stored in the worktree's local D1 decryptable.
if [ -f "$dev_vars_dst" ] \
   && ! grep -Eq '^AI_KEY_WRAPPING_KEY=.*[^[:space:]]' "$dev_vars_dst"; then
  if command -v openssl >/dev/null 2>&1; then
    wrapping_key=$(openssl rand -base64 32)
  else
    wrapping_key=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
  fi
  chmod 600 "$dev_vars_dst"
  if grep -Eq '^AI_KEY_WRAPPING_KEY=' "$dev_vars_dst"; then
    # Replace the empty line in place. The key goes in through the environment,
    # not argv, and awk handles base64's / and + without sed escaping.
    tmp_vars="$dev_vars_dst.tmp.$$"
    ( umask 077
      WRAPPING_KEY="$wrapping_key" awk '
        /^AI_KEY_WRAPPING_KEY=/ { print "AI_KEY_WRAPPING_KEY=" ENVIRON["WRAPPING_KEY"]; next }
        { print }
      ' "$dev_vars_dst" > "$tmp_vars" )
    mv "$tmp_vars" "$dev_vars_dst"
  else
    # Append, adding a newline first if the file doesn't end with one.
    if [ -s "$dev_vars_dst" ] && [ -n "$(tail -c 1 "$dev_vars_dst")" ]; then
      echo >> "$dev_vars_dst"
    fi
    echo "AI_KEY_WRAPPING_KEY=$wrapping_key" >> "$dev_vars_dst"
  fi
  unset wrapping_key
  echo "generated a local AI_KEY_WRAPPING_KEY in api/.dev.vars (worktree only)"
elif [ -f "$dev_vars_dst" ]; then
  echo "api/.dev.vars already has AI_KEY_WRAPPING_KEY - leaving it alone."
fi

# Step 2: install dependencies if absent. npm >= 11.19 prints harmless
# install-scripts warnings for esbuild/sharp/workerd/core-js — the Vite build,
# `wrangler dev`, and sign-in all work with those scripts skipped, so do NOT add
# --allow-scripts for them.
if [ -d "$worktree_root/node_modules" ]; then
  echo "node_modules already present (real install) - skipping. Delete it to force a reinstall."
else
  echo "Installing dependencies (npm install) in $worktree_root ..."
  npm install
  echo "Worktree ready - self-contained node_modules, no link to main."
fi

# Step 3: build web/dist if absent. api/wrangler.toml's [assets] directory is
# "../web/dist"; `wrangler dev` exits at once ("The directory specified by the
# 'assets.directory' field ... does not exist") when it's missing, and Vite is
# left orphaned on :5173 so the next run slides to :5174.
if [ -d "$worktree_root/web/dist" ]; then
  echo "web/dist already present - skipping build."
else
  echo "Building web/dist (npm run build:web) ..."
  npm run build:web
fi

# Step 4: apply local D1 migrations. Without them the local SQLite has no schema
# and `POST /api/auth/dev` 500s with "no such table: users". `migrations apply`
# is itself idempotent (applies only unapplied migrations), so it is safe to run
# every time; answer its prompt non-interactively.
echo "Applying local D1 migrations (bptranslate_dev) ..."
( cd "$worktree_root/api" && printf 'y\n' | npx wrangler d1 migrations apply bptranslate_dev --local )

# Step 5: rebuild graft's local index if this is a graft-wired checkout, graft
# is installed, and the index isn't already there (graft/ is gitignored, so a
# fresh worktree has none and would answer from main's index). Best-effort:
# never fail init over it.
if [ -f "$worktree_root/.claude/skills/graft/SKILL.md" ] \
   && [ ! -d "$worktree_root/graft" ] \
   && command -v graft >/dev/null 2>&1; then
  echo "Building graft index (graft build) ..."
  graft build || echo "graft build failed (non-fatal) - skipping."
fi

echo "Worktree init complete."
