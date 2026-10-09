// Client-side notion of "which org am I in" — the localStorage mirror of the
// server's be_ws cookie. Kept dependency-free (no imports from api.ts) so
// outbox.ts can import it without creating a module cycle (outbox.ts already
// imports from api.ts).

const STORAGE_KEY = "bible-editor.workspace";
const FALLBACK_KEY = "bible-editor.workspace-is-fallback";

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

// Whether the current workspace slug is the FALLBACK one — the first entry
// in WORKSPACES (or the sole implicit "default" workspace when WORKSPACES is
// unset). outbox.ts's outboxDbName() keeps the legacy unsuffixed
// "bible-editor-outbox" IndexedDB name for the fallback workspace specifically
// (not for whichever slug happens to be literally "default") so pre-
// workspaces installs' queued edits are never orphaned by the first real
// WORKSPACES deploy — see outbox.ts for the full rationale.
//
// Unknown (never persisted — a pre-this-feature localStorage, or a boot
// before the first /api/auth/me response lands) is treated as fallback ONLY
// when the slug is itself "default", preserving today's behavior. A real but
// not-yet-confirmed slug conservatively suffixes: a wrongly-suffixed outbox
// just opens a fresh empty database, where a wrongly-unsuffixed one could
// mix two different orgs' queued edits into the legacy database.
export function getWorkspaceIsFallback(): boolean {
  try {
    const raw = localStorage.getItem(FALLBACK_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    /* private mode */
  }
  return getWorkspaceSlug() === "default";
}

export function setWorkspaceIsFallback(isFallback: boolean): void {
  try {
    localStorage.setItem(FALLBACK_KEY, isFallback ? "1" : "0");
  } catch {
    /* private mode — nothing we can do, next boot re-derives from the server */
  }
}

// Derive a per-workspace IndexedDB name from a fixed base, applying the exact
// fallback rule described above: the FALLBACK workspace keeps the legacy
// unsuffixed base name (so pre-workspaces data is never orphaned), every other
// workspace gets a "-{slug}" suffix. Every per-workspace store — the outbox
// (outbox.ts) and BOTH drafts stores (drafts.ts, alignmentDrafts.ts) — must
// route its DB name through here so a workspace switch can never surface one
// org's queued edits or unsaved drafts in another (issue #228).
export function workspaceDbName(base: string): string {
  return getWorkspaceIsFallback() ? base : `${base}-${getWorkspaceSlug()}`;
}
