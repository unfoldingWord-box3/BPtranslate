// Smoke test for workspace.ts's fallback-workspace tracking — the piece
// outbox.ts's outboxDbName() relies on to decide whether to keep the legacy
// unsuffixed "bible-editor-outbox" IndexedDB name (see ISSUE 3: queued
// offline edits must not be orphaned the first time WORKSPACES is enabled).
//
// Run from repo root:
//   node --experimental-strip-types --no-warnings web/src/sync/workspace.test.mjs

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

function installLocalStorage() {
  const data = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(String(key), String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
  };
  return data;
}

const data = installLocalStorage();
const {
  getWorkspaceSlug,
  setWorkspaceSlug,
  getWorkspaceIsFallback,
  setWorkspaceIsFallback,
  workspaceDbName,
} = await import("./workspace.ts");

// ── fresh install: nothing persisted yet ────────────────────────────────────

assert(getWorkspaceSlug() === "default", "fresh install: slug defaults to 'default'");
assert(
  getWorkspaceIsFallback() === true,
  "fresh install: unknown fallback flag + slug 'default' -> treated as fallback (today's behavior preserved)",
);

// ── ISSUE 3 regression: the fallback flag follows the FIRST/fallback ───────
// workspace's real slug, not the literal string "default". Simulates the
// first WORKSPACES deploy, where dev's fallback workspace gets slug "bsoj".

setWorkspaceSlug("bsoj");
setWorkspaceIsFallback(true);
assert(getWorkspaceSlug() === "bsoj", "slug persisted");
assert(
  getWorkspaceIsFallback() === true,
  "a non-'default' slug is still treated as fallback once the server said so — " +
    "outboxDbName() must keep the legacy unsuffixed name here, not orphan queued edits",
);

// Switching to a genuinely non-fallback workspace flips the flag, even
// though neither slug is the literal string "default".
setWorkspaceSlug("org2");
setWorkspaceIsFallback(false);
assert(getWorkspaceSlug() === "org2", "slug updated on switch");
assert(getWorkspaceIsFallback() === false, "non-fallback workspace -> isFallback false -> outbox gets the '-org2' suffix");

// Switching back to the fallback workspace flips it back.
setWorkspaceSlug("bsoj");
setWorkspaceIsFallback(true);
assert(getWorkspaceIsFallback() === true, "switching back to the fallback workspace restores isFallback true");

// ── unknown flag (never persisted this session) falls back to the literal
// "default" check — e.g. localStorage predating this feature ───────────────

data.delete("bible-editor.workspace-is-fallback");
setWorkspaceSlug("bsoj");
assert(
  getWorkspaceIsFallback() === false,
  "unknown fallback flag + non-'default' slug -> NOT assumed fallback (safer: suffixes rather than " +
    "risking two orgs sharing the legacy unsuffixed outbox)",
);
setWorkspaceSlug("default");
assert(
  getWorkspaceIsFallback() === true,
  "unknown fallback flag + literal slug 'default' -> assumed fallback (today's pre-workspaces behavior)",
);

// ── issue #228: workspaceDbName() applies the same fallback rule to EVERY
// per-workspace IndexedDB store (outbox + both drafts stores), so switching
// orgs can never surface one org's unsaved drafts in another ────────────────

// Fallback workspace -> legacy unsuffixed base name (pre-workspaces data safe).
setWorkspaceSlug("bsoj");
setWorkspaceIsFallback(true);
assert(
  workspaceDbName("bible-editor-drafts") === "bible-editor-drafts",
  "fallback workspace: drafts DB keeps the legacy unsuffixed base name (not orphaned)",
);
assert(
  workspaceDbName("bible-editor-outbox") === "bible-editor-outbox",
  "fallback workspace: outbox DB name matches outboxDbName()'s legacy output",
);

// Non-fallback workspace -> "-{slug}" suffix, keyed off the real slug.
setWorkspaceSlug("org2");
setWorkspaceIsFallback(false);
assert(
  workspaceDbName("bible-editor-drafts") === "bible-editor-drafts-org2",
  "non-fallback workspace: drafts DB is suffixed with the slug",
);
assert(
  workspaceDbName("bible-editor-alignment-drafts") === "bible-editor-alignment-drafts-org2",
  "non-fallback workspace: alignment-drafts DB is suffixed with the slug",
);
assert(
  workspaceDbName("bible-editor-outbox") === "bible-editor-outbox-org2",
  "non-fallback workspace: outbox DB is suffixed identically to the drafts stores",
);

console.log("\nAll workspace smoke checks passed.");
