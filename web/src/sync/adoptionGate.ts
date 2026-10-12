// Runs legacy adoption (#502, legacyAdoption.ts) BEFORE any editor mounts.
//
// Editors read their draft once, when they mount, so adoption must never run
// while one is open (see the invariant in legacyAdoption.ts). App.tsx holds
// the editor surfaces while adoptBeforeEditors() is pending, and only on a
// boot where needsAdoptionGate() is true (named fallback slug, confirmed by
// /api/auth/me). Every other boot never waits.
//
// The lock-free emptiness check starts when this module loads, in parallel
// with /api/auth/me, so a boot with nothing left to adopt (every boot after
// the first) is released as soon as auth is; it never takes a lock.

import { getWorkspaceSlug } from "./workspace";
import { ADOPTION_WAIT_MS, anyLegacyRecords, runBounded } from "./legacyAdoption";
import { adoptLegacyDrafts, legacyDraftsSource } from "./drafts";
import { adoptLegacyAlignmentDrafts, legacyAlignmentDraftsSource } from "./alignmentDrafts";
import { adoptLegacyOutbox, legacyOutboxSource } from "./outbox";

// Started at module load for a named slug. A failed check counts as "nothing
// to adopt": the legacy data stays where it is and the next boot checks again.
const bootSlug = getWorkspaceSlug();
let knownEmpty = bootSlug === "default";
const legacyCheck: Promise<boolean> = knownEmpty
  ? Promise.resolve(false)
  : anyLegacyRecords([
      legacyDraftsSource(bootSlug),
      legacyAlignmentDraftsSource(bootSlug),
      legacyOutboxSource(bootSlug),
    ])
      .catch(() => false)
      .then((found) => {
        if (!found) knownEmpty = true;
        return found;
      });

// True once the check above found nothing to adopt, so App.tsx renders the
// editors without even one render of the hold (the usual case, since the
// check finishes before /api/auth/me does).
export function nothingToAdopt(): boolean {
  return knownEmpty;
}

let once: Promise<void> | null = null;

// Adopt `slug`'s legacy records, once per page load. Resolves when adoption
// finished, found nothing, or was skipped; never rejects. Bounded by
// ADOPTION_WAIT_MS: past it, adoption is aborted and this resolves once it has
// stopped (or ADOPTION_GRACE_MS later at most; a step that resumes after that
// sees the abort and moves nothing), so nothing is moved once editors render.
// A skipped boot leaves the rest in the legacy database for the next boot.
export function adoptBeforeEditors(slug: string): Promise<void> {
  if (!once) {
    once = runBounded(async (signal) => {
      if (slug !== bootSlug || !(await legacyCheck)) return;
      // Drafts first, then the outbox, so an adopted op that lands and clears
      // its draft finds the draft already moved. A step that throws (a lock
      // failure included) or an abort ends the run: the remaining steps wait
      // for the next boot.
      for (const adopt of [adoptLegacyDrafts, adoptLegacyAlignmentDrafts, adoptLegacyOutbox]) {
        if (signal.aborted) return;
        await adopt(slug, signal);
      }
    }, ADOPTION_WAIT_MS).then(() => undefined);
  }
  return once;
}
