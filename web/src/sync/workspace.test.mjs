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

// ── issue #502: reconcilableSiblingDbName() — the SAFE-to-adopt sibling of the
// name a store actually opened. It exists so an edit/draft queued under one
// member of the { base, base-{slug} } pair (the fallback flag is boot-timed, so
// the same workspace can open either across a reload) is rescued, not stranded —
// WITHOUT ever mixing two orgs' data. ────────────────────────────────────────

const BASE = "bible-editor-outbox";
const { reconcilableSiblingDbName } = await import("./workspace.ts");

// Fallback workspace (its slug is a real, non-"default" string, e.g. "bsoj"):
// the two candidate names both belong to it, so each is the other's safe sibling
// regardless of which one this session happened to open.
setWorkspaceSlug("bsoj");
setWorkspaceIsFallback(true);
assert(
  reconcilableSiblingDbName(BASE, "bible-editor-outbox") === "bible-editor-outbox-bsoj",
  "fallback + opened legacy base -> adopt from the suffixed mistimed-write DB",
);
assert(
  reconcilableSiblingDbName(BASE, "bible-editor-outbox-bsoj") === "bible-editor-outbox",
  "fallback + opened suffixed (flag not yet landed at open) -> adopt from legacy base",
);

// Non-fallback workspace: the unsuffixed `base` is the FALLBACK workspace's home
// and may hold another org's edits, so it is NEVER a safe sibling to adopt into
// a suffixed store — the whole point of the suffixing.
setWorkspaceSlug("org2");
setWorkspaceIsFallback(false);
assert(
  reconcilableSiblingDbName(BASE, "bible-editor-outbox-org2") === null,
  "non-fallback: never adopt the shared legacy base into a suffixed store (no org mixing)",
);
assert(
  reconcilableSiblingDbName(BASE, "bible-editor-outbox") === null,
  "non-fallback: opening the legacy base itself has no safe sibling either",
);

// A different org's suffixed DB is not a member of the current slug's pair.
setWorkspaceSlug("bsoj");
setWorkspaceIsFallback(true);
assert(
  reconcilableSiblingDbName(BASE, "bible-editor-outbox-org2") === null,
  "another org's suffixed DB is not part of this slug's pair -> left untouched",
);

// The implicit "default" workspace never suffixes, so there is only one
// candidate name and thus no pair to reconcile.
data.delete("bible-editor.workspace");
data.delete("bible-editor.workspace-is-fallback");
assert(getWorkspaceSlug() === "default", "reset to implicit default");
assert(
  reconcilableSiblingDbName(BASE, "bible-editor-outbox") === null,
  "default workspace: single candidate name, nothing to reconcile",
);

console.log("\nAll workspace smoke checks passed.");
