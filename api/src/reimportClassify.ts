// How the reimport should treat an existing (non-tombstone) row when it also
// appears in the incoming master TSV. Pure decision, split out so it is unit-
// testable without dragging in bookReimport's runtime deps.
//
// The reorder-preservation invariant (the reason this is its own function):
// a TN/TWL reorder writes only sort_order via the rows.ts fast path — it does
// NOT bump version or updated_by, so the row still reads as pristine. If the
// reimport keyed "no-op" on sort_order matching (it used to: sigMatch &&
// sortMatches), a reordered-but-content-identical row looked like a pristine
// change and got its sort_order overwritten back to master file order — the
// documented HOS 11 TN / HOS 12 TWL reorder-revert bug. Order flows app→master
// (the nightly export renders D1's sort_order into TSV row order), so for those
// rows D1 is the source of truth for order and a content-identical row must
// PRESERVE its local sort_order rather than adopt file order.
//
// This preservation is SCOPED (see caller): only tn/twl (the resources with an
// in-app reorder gesture) whose row already carries a non-null sort_order.
// (twl caveat: this only preserves the row through the reimport row loop —
// canonical ULT-position order is (re)asserted afterwards by the twl canonical
// post-pass in bookReimport.runReimport, which owns twl sort_order.)
//   - tq has NO in-app reorder (its PATCH schema has no sort_order; the fast
//     path can't fire for it), so master file order stays authoritative — a
//     master-side reorder must still sync in.
//   - a NULL sort_order carries no order to preserve, so a content-identical
//     null row must still be repaired to file order (else it exports at the end
//     via `NULLS LAST`).
// Both of those fall through to the normal adopt-from-master path.
//
// "reimportable" (below) is broader than "pristine": a row the AI pipeline wrote
// but no human has since edited is also safe to overwrite from master (see
// isReimportableRow). Such a row is re-seeded AND returned to master-owned
// (updated_by → NULL); the caller writes it under a relaxed guard (version-CAS
// + re-asserted protections) and counts it as `reimported_ai` rather than the
// misleading `skipped_edited`. `aiOnly` distinguishes that case so the caller
// picks the right write guard + counter.
export type ReimportFate = "noop" | "edited" | "update" | "update_ai";

export function classifyReimportRow(
  contentMatches: boolean,
  sortMatches: boolean,
  reimportable: boolean,
  preserveLocalOrder: boolean,
  aiOnly = false,
): ReimportFate {
  // Content AND order both match master → nothing to import.
  if (contentMatches && sortMatches) return "noop";
  // Content matches but order differs, and this row owns its order locally
  // (tn/twl with a stored sort_order) → preserve the reorder; do NOT adopt
  // master file order. This is the reorder-revert fix. (Applies to AI-only rows
  // too: a content-identical row that only differs in order stays a no-op — the
  // AI never gains a stale re-seed; it self-heals to master-owned on the next
  // content change.)
  if (contentMatches && preserveLocalOrder) return "noop";
  // Otherwise the row must take master's content and/or file-order sort_order:
  // content drifted, OR order diverged on a row whose order master owns (tq /
  // null sort_order). A human-edited row is never clobbered; a pristine one is
  // updated from master; an AI-only one is re-seeded AND reclaimed to
  // master-owned via the update_ai path.
  if (!reimportable) return "edited";
  return aiOnly ? "update_ai" : "update";
}

// Source label the AI pipeline stamps on every edit_log row it writes. Kept in
// sync with pipelineImport.ts AI_SOURCE (the delete-sweep precedent this mirrors).
export const AI_SOURCE = "ai_pipeline";

// Column shape needed to decide whether a reimport may overwrite a row.
export interface ReimportableRow {
  // Non-null once anyone (human OR the AI pipeline) has written the row.
  updated_by: number | null;
  // source of the latest content-bearing (create/update) edit_log entry for the
  // row, or null if none / not fetched. The ONLY signal that separates an
  // AI-written row (source = ai_pipeline) from a human edit (source null/manual)
  // once updated_by is set.
  latestSource: string | null;
  deleted_at: number | null;
  // Provenance stamp for a BULK review-state write (migration 0071): the admin
  // sweep (reviewState.ts) or the Aquifer importer's bulk approve. tn/tq only —
  // twl and verse have no such column, and pass undefined.
  //
  // MUST be selected by the caller. bookReimport.ts's two row SELECTs read it
  // explicitly; if it is dropped from either, this field arrives `undefined`,
  // the guard below silently never fires, and #394 is back with no test failing.
  admin_bulk_state?: string | null;
  // tn/tq translation_state. 'validated' blocks overwrite (issue #414 / #732).
  // MUST be selected by the caller, like admin_bulk_state, or the guard below
  // never fires. twl and verse have no such column, and pass undefined.
  translation_state?: string | null;
  // tn-only human-owned protections. Ignored for tq/twl/verse.
  trashed_at?: number | null;
  preserve?: number | null;
  hint?: number | null;
  kind: "tn" | "tq" | "twl" | "verse";
}

// True iff the reimport may overwrite this (non-tombstone) row from master.
// Two admissible cases, both meaning "no human owns this row":
//   1. pristine        — updated_by IS NULL (never touched at all);
//   2. AI-only         — updated_by set, but the latest content edit_log entry
//                        is source = ai_pipeline (the AI pipeline wrote it and no
//                        human has edited it since — a human PATCH would write a
//                        null/manual-source edit_log row, flipping this false).
// Human-owned protections still block overwrite regardless of the above: a
// tombstone (deleted_at), a note queued for deletion (trashed_at), or an
// explicit preserve/hint flag (tn). This mirrors the pipelineImport deleteUnkeptTns
// safety predicate; the caller re-asserts the same conditions at write time
// (version-CAS + flag re-assertion) so a human edit landing mid-import can't be
// clobbered.
//
// A BULK REVIEW-STATE STAMP ALSO BLOCKS OVERWRITE (issue #394, option (a)).
// The admin bulk sweep and the Aquifer bulk approve set translation_state (and
// pre_draft_json) but deliberately NOT updated_by — authorship stays with
// whoever wrote the note, matching the per-row validate helper. Without this
// test such a row still reads as pristine, so the nightly reimport rewrites its
// CONTENT from master while the 'validated' label and the now-stale
// pre_draft_json snapshot stay put: the label then describes content nobody
// approved. Option (b) (have the sweep claim updated_by) was rejected because
// it makes bulk approval claim authorship of rows the admin never wrote, and
// (c) (accept the overwrite) is the data-integrity smell the issue exists to
// remove. So the stamp — which is precisely the record that someone made a
// deliberate statement about this row — makes it non-pristine here. Content
// drift on master for such a row is reported as `skipped_edited`, the same
// visible outcome as any other human-owned row.
//
// AN APPROVED ROW ALSO BLOCKS OVERWRITE (issues #414 and #732). Approving a row
// (POST /rows/{tn,tq}/:id/validate) is a state flip: it leaves updated_by alone
// and its edit_log action ('validate') is not a create/update, so latestSource
// still reads ai_pipeline for an AI draft a person approved without editing,
// and still reads nothing for a bulk-approved imported row once a hand approval
// has cleared its stamp. Either would pass the two cases above, and the reimport
// would rewrite approved content while the 'validated' label and pre_draft_json
// stayed put. Every write of 'validated' is a person's approval or a stamped
// bulk approval, so an untouched imported row (state NULL) is unaffected.
export function isReimportableRow(r: ReimportableRow): boolean {
  if (r.deleted_at != null) return false;
  if (r.admin_bulk_state != null) return false;
  if (r.translation_state === "validated") return false;
  if (r.kind === "tn") {
    if (r.trashed_at != null) return false;
    if (Number(r.preserve ?? 0) !== 0) return false;
    if (Number(r.hint ?? 0) !== 0) return false;
  }
  if (r.updated_by == null) return true; // pristine
  return r.latestSource === AI_SOURCE; // AI-only, never human-edited
}

// ── Reissued-tombstone discriminator (issue #427, options 1 and 2) ──────────
//
// A soft-deleted tn/tq/twl row keeps its `(book, id)` PRIMARY KEY slot forever
// — the row stays, only `deleted_at` is stamped. So when master's TSV carries
// that same id, the reimport's tombstone branch (bookReimport.ts's applyTsvRows)
// declines to apply master's row, and its `INSERT ... ON CONFLICT(id, book) DO
// NOTHING` would refuse it too. Both outcomes are silent: master's row simply
// never lands in D1.
//
// That silence is CORRECT for one of the two cases and WRONG for the other, and
// this function is the discriminator (the same one upstream's 2026-08-10
// production sweep used to classify all 10,645 live tombstones):
//
//   - master carries the id at the SAME reference → the row is a delete that
//     hasn't been exported to Door43 yet. Skipping is exactly what preserves
//     that pending deletion; reapplying master's copy would resurrect it on
//     every nightly run. Returns false. (4 AMO rows were in this state during
//     the sweep.)
//   - master carries the id at a DIFFERENT reference → the id has been reissued
//     to a genuinely different row (bp-assistant mints ids from a repeating
//     sequence, so collisions recur). Master's row is real, new, and being
//     dropped. Returns true. This is the 1CH 23 tQ case: six ids tombstoned at
//     1CH 5:x were reissued at 1CH 23:x and vanished, and the book's watermark
//     was stamped in-sync anyway.
//
// Deliberately compares the REFERENCE, not the content: a reissued id points at
// different scripture, which is the only signal available without reading the
// whole book. `ref_raw` is the authoritative comparison (it is what the master
// TSV's Reference column literally holds, including verse bridges like "1:2-3"
// and "front:intro"); (chapter, verse) is the fallback when a row's ref_raw is
// empty.
//
// KNOWN FALSE POSITIVE, and its cost is not small — read before touching this.
// The reference test cannot separate "the id was re-minted for a different row"
// (real loss) from "the SAME row, deleted in-app, whose Reference a Door43
// maintainer then corrected" — a re-anchor to 1:3, or a bridge widened to
// "1:2-3". The second loses nothing; the row is deleted and the delete is merely
// pending export. This function reports both as reissued.
//
// Do NOT reason about that as "worst case, a delayed export." A true positive
// here now drives an ACTUAL WRITE — see bookReimport.ts's tombstone branch,
// which reclaims the slot (issue #427, option 1): it clears deleted_at and
// overwrites the row with master's incoming content at the new reference.
// So a false positive no longer just freezes the export until a human
// intervenes (the pre-option-1 behavior); it silently un-deletes a row a
// translator explicitly deleted, at whatever reference the maintainer's
// correction happens to name. The direction is still deliberate — the
// alternative to reclaiming is leaving a D1 that is short of master, which
// (on export) DELETES rows from Door43 that master genuinely still carries,
// the original 1CH failure — but this is the sharper edge of that tradeoff,
// not a free one. When the reclaim instead LOSES its version-CAS race
// (something touched the tombstoned row between the read and the write), the
// caller falls back to `tombstone_blocked` and raiseTombstoneBlockAlert makes
// that visible; see the caller for why that residual case is expected to
// self-heal on the next sync.
//
// The 2026-08-10 production sweep found 0 reissued across 10,645 tombstones,
// which bounds how often this fires today — but it is a point-in-time shape,
// not a bound on the false-positive rate going forward.
//
// This function does NOT itself write anything — it only decides whether
// master's row should be reclaimed. Issue #427's option 1 (id reclaim) has
// SHIPPED and is the caller (bookReimport.ts's applyTsvRows) that acts on this
// verdict; this function is unchanged by that — it still only answers "same
// reference or different?", exactly as before.
//
// Pure (no D1) so it is regression-testable — see reimportClassify.test.mjs.
export interface TombstoneRef {
  refRaw?: string | null;
  chapter: number;
  verse: number;
}

function normalizeRef(r: TombstoneRef): string {
  const raw = (r.refRaw ?? "").trim().replace(/\s+/g, "");
  if (raw !== "") return raw;
  return `${r.chapter}:${r.verse}`;
}

export function isReissuedTombstone(stored: TombstoneRef, incoming: TombstoneRef): boolean {
  return normalizeRef(stored) !== normalizeRef(incoming);
}
