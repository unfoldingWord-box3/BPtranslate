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
// Naming rule: slug "default" (the implicit single workspace, WORKSPACES
// unset, as on prod) keeps the unsuffixed legacy `base`, so those installs
// need no migration and a rollback to an older build still finds their
// queued edits. Every other slug gets "-{slug}" so one org's queued edits or
// unsaved drafts can never surface in another org (#228).
//
// Older builds also wrote a NAMED fallback workspace's data (e.g. "bsoj") to
// `base`. legacyAdoption.ts moves those records into `base-{slug}` once the
// server confirms that slug is the fallback (see legacyDbNames below).
export function workspaceDbName(base: string): string {
  const slug = getWorkspaceSlug();
  return slug === "default" ? base : `${base}-${slug}`;
}

// Databases whose records belong to the confirmed fallback workspace
// `fallbackSlug` but that its tabs no longer write to. For a named fallback
// slug that is `base`, where every build before #502 stored its data. For
// "default" there is none: it writes `base` itself. Only the fallback
// workspace ever adopts, so a non-fallback org never takes another org's
// records.
//
// Known gap, unchanged from main: on a named-fallback deployment a tab whose
// localStorage was cleared (but not its IndexedDB) starts as slug "default"
// and opens `base` until App.tsx's reconcile reload. Writes it makes there are
// adopted later by the fallback org; if the server put it in a non-fallback
// org, those writes reach the fallback org, as they already do on main.
export function legacyDbNames(base: string, fallbackSlug: string): string[] {
  return fallbackSlug === "default" ? [] : [base];
}
