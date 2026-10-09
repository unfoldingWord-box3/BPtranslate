// Client-side notion of "which org am I in" — the localStorage mirror of the
// server's be_ws cookie. Kept dependency-free (no imports from api.ts) so
// outbox.ts can import it without creating a module cycle (outbox.ts already
// imports from api.ts).

const STORAGE_KEY = "bible-editor.workspace";
const FALLBACK_KEY = "bible-editor.workspace-is-fallback";
// The slug FALLBACK_KEY was last confirmed for (see setWorkspaceIsFallback).
const FALLBACK_FOR_KEY = "bible-editor.workspace-fallback-for";

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
    // A fallback flag describes the slug it was confirmed for. When the slug
    // changes, drop it so the new slug reads as "unknown" (conservatively
    // suffixed) until the server confirms it. Callers that know the answer set
    // it right after. Without this, api.ts's workspace_mismatch reload (which
    // changes only the slug) left a stale "1" that sent a non-fallback org's
    // edits into the fallback's unsuffixed DB, where no later session of that
    // org looks (issue #502).
    if (slug !== getWorkspaceSlug()) {
      localStorage.removeItem(FALLBACK_KEY);
      localStorage.removeItem(FALLBACK_FOR_KEY);
    }
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

// Listeners for "the fallback flag was just confirmed for the current slug,
// and that confirmation is new" (issue #502). The per-workspace stores open at
// module load, often BEFORE boot confirms the flag, so their adopt-on-open pass
// found nothing safe to adopt. They register here to run it again once the
// confirmation lands. A Set of callbacks keeps this module import-free.
const confirmedListeners = new Set<() => void>();
export function onFallbackConfirmed(fn: () => void): () => void {
  confirmedListeners.add(fn);
  return () => confirmedListeners.delete(fn);
}

export function setWorkspaceIsFallback(isFallback: boolean): void {
  const slug = getWorkspaceSlug();
  const value = isFallback ? "1" : "0";
  let isNew = false;
  try {
    isNew =
      localStorage.getItem(FALLBACK_FOR_KEY) !== slug ||
      localStorage.getItem(FALLBACK_KEY) !== value;
    localStorage.setItem(FALLBACK_KEY, value);
    // Record which slug this flag was confirmed for. Every caller sets the slug
    // first, so this is the slug the flag describes. reconcilableSiblingDbName
    // refuses to adopt unless it matches the current slug (issue #502).
    localStorage.setItem(FALLBACK_FOR_KEY, slug);
  } catch {
    /* private mode — nothing we can do, next boot re-derives from the server */
    return;
  }
  if (!isNew) return;
  for (const fn of confirmedListeners) {
    try {
      fn();
    } catch {
      /* a listener's failure must not break boot */
    }
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

// Issue #502: workspaceDbName()'s result depends on the fallback flag, which is
// written during boot (App.tsx) — so across a reload the same browser can pick a
// DIFFERENT name for the SAME workspace. The two candidate names for the current
// slug are always the pair { base, `${base}-${slug}` }: the unknown/early window
// resolves to one (slug still "default", or flag not yet landed) and the settled
// window to the other. An edit/draft queued under one is invisible to the next
// session that opened the other, and never flushes — silent loss on the save
// protocol's "durable across tab close" claim.
//
// Given the name a store ACTUALLY opened this session, this returns the other
// member of that pair when — and only when — it is SAFE to adopt its records
// into `opened`, else null. Safety is the whole point:
//
//   - Both members of the pair provably belong to the CURRENT workspace only for
//     the FALLBACK workspace. There `base` is the fallback's own legacy home and
//     `${base}-${slug}` is where a mistimed pre-flag write went, so moving records
//     between them stays inside one workspace.
//   - For a NON-fallback workspace the unsuffixed `base` is the *fallback*
//     workspace's store and may hold a different org's records; adopting from it
//     would mix two orgs' edits — the exact hazard workspaceDbName's suffixing
//     exists to prevent. So we never reconcile it. (This is the same "suffixing is
//     the conservative side" reasoning in outbox.ts's outboxDbName comment.)
//
// `opened` must be a member of the current slug's pair; anything else (e.g. a
// different org's `${base}-${otherSlug}`) returns null and is left untouched.
export function reconcilableSiblingDbName(base: string, opened: string): string | null {
  const slug = getWorkspaceSlug();
  // "default" never suffixes, so there is only one candidate name — no pair.
  if (slug === "default") return null;
  const suffixed = `${base}-${slug}`;
  const sibling = opened === base ? suffixed : opened === suffixed ? base : null;
  if (sibling === null) return null; // `opened` isn't a member of this slug's pair
  // Only the fallback workspace can safely reconcile the pair (see above), and
  // only when the server confirmed "fallback" for THIS slug. A flag left over
  // from another slug (api.ts's workspace_mismatch reload changes the slug but
  // not the flag) would otherwise move a non-fallback org's ops into the
  // fallback's unsuffixed DB.
  if (!getWorkspaceIsFallback()) return null;
  let confirmedFor: string | null = null;
  try {
    confirmedFor = localStorage.getItem(FALLBACK_FOR_KEY);
  } catch {
    /* private mode */
  }
  if (confirmedFor !== slug) return null;
  return sibling;
}
