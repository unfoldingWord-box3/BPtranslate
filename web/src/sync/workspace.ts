// Client-side notion of "which org am I in" — the localStorage mirror of the
// server's be_ws cookie. Kept dependency-free (no imports from api.ts) so
// outbox.ts can import it without creating a module cycle (outbox.ts already
// imports from api.ts).

const STORAGE_KEY = "bible-editor.workspace";

export function getWorkspaceSlug(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || "default";
  } catch {
    // Privacy-mode localStorage throws on access — fall back to the implicit
    // single-workspace default rather than crashing module init.
    return "default";
  }
}

export function setWorkspaceSlug(slug: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, slug);
  } catch {
    /* private mode — nothing we can do, next boot re-derives from the server */
  }
}

// Per-workspace IndexedDB names (issues #228, #502).
//
// INVARIANT: at any moment, current code writes each store (the outbox, the
// text drafts, the alignment drafts) into exactly ONE database: the one named
// by workspaceDbName(), which depends on the workspace slug and nothing else.
// The name must never depend on state that arrives later in the session.
// Issue #502 was exactly that: the name used to depend on the server's
// "is this the fallback workspace" flag. An edit queued before /api/auth/me
// landed went into `base-{slug}`, every later session opened unsuffixed
// `base`, and the queued edit was never sent.
//
// Durability: the name is known at module load, so an edit is durable in its
// database the moment it is queued, online or offline, and a later session
// on the same slug opens the same database and drains it. Nothing waits on
// the server.
//
// Each workspace gets its own "-{slug}" suffix so one org's queued edits or
// unsaved drafts can never surface in another org (#228). The implicit
// single workspace uses "-default" like any other slug.
//
// Older builds wrote the fallback workspace's data to the unsuffixed `base`.
// No current-code tab writes there, so legacyAdoption.ts can move those
// records into `base-{slug}` once the server confirms which slug is the
// fallback (see legacyDbNames below).
export function workspaceDbName(base: string): string {
  return `${base}-${getWorkspaceSlug()}`;
}

// Databases whose records belong to the confirmed fallback workspace
// `fallbackSlug` but that current code never writes to:
//   - `base`: where every build before #502 stored the fallback workspace's
//     data (pre-workspaces installs, and the fallback org after WORKSPACES was
//     configured).
//   - `base-default`: the implicit single workspace (WORKSPACES unset, as on
//     prod today). The first deploy that configures WORKSPACES renames that
//     workspace to a real slug, which would otherwise strand these records.
//     Only for a fallback slug other than "default", since "default" itself
//     writes there.
// Only the fallback workspace ever adopts. A non-fallback org gets no sources,
// so two orgs' edits are never mixed.
export function legacyDbNames(base: string, fallbackSlug: string): string[] {
  return fallbackSlug === "default" ? [base] : [base, `${base}-default`];
}
