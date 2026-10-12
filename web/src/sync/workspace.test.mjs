// Smoke test for workspace.ts's per-workspace IndexedDB naming. The name
// depends on the slug alone, never on the server's fallback flag, so it can
// not change mid-session and strand a queued edit (#502). legacyDbNames lists
// where older builds kept the fallback workspace's data.
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
const { getWorkspaceSlug, setWorkspaceSlug, workspaceDbName, legacyDbNames } = await import(
  "./workspace.ts"
);

// ── fresh install: nothing persisted yet ────────────────────────────────────

assert(getWorkspaceSlug() === "default", "fresh install: slug defaults to 'default'");
assert(
  workspaceDbName("bible-editor-outbox") === "bible-editor-outbox",
  "implicit single workspace ('default') keeps the unsuffixed legacy name: no migration, rollback-safe",
);

// ── #502: the name ignores the fallback flag, set or not ───────────────────

setWorkspaceSlug("bsoj");
data.delete("bible-editor.workspace-is-fallback");
const before = workspaceDbName("bible-editor-outbox");
data.set("bible-editor.workspace-is-fallback", "1");
assert(
  workspaceDbName("bible-editor-outbox") === before && before === "bible-editor-outbox-bsoj",
  "the outbox name is the same before and after the server confirms the fallback flag",
);

// ── issue #228: every per-workspace store is suffixed by the real slug ─────

setWorkspaceSlug("org2");
assert(
  workspaceDbName("bible-editor-drafts") === "bible-editor-drafts-org2",
  "drafts DB is suffixed with the slug",
);
assert(
  workspaceDbName("bible-editor-alignment-drafts") === "bible-editor-alignment-drafts-org2",
  "alignment-drafts DB is suffixed with the slug",
);
assert(
  workspaceDbName("bible-editor-outbox") === "bible-editor-outbox-org2",
  "outbox DB is suffixed identically to the drafts stores",
);

// ── legacy sources for the confirmed fallback workspace ────────────────────

assert(
  legacyDbNames("bible-editor-outbox", "default").length === 0,
  "the implicit single workspace never adopts (it writes the unsuffixed name itself)",
);
assert(
  JSON.stringify(legacyDbNames("bible-editor-outbox", "bsoj")) === JSON.stringify(["bible-editor-outbox"]),
  "a named fallback workspace adopts only the unsuffixed legacy DB",
);
setWorkspaceSlug("bsoj");
assert(
  !legacyDbNames("bible-editor-outbox", "bsoj").includes(workspaceDbName("bible-editor-outbox")),
  "a workspace never adopts from its own live database",
);

console.log("\nAll workspace smoke checks passed.");
