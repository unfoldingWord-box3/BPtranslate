-- 0089: dismissed "Note kinds marked Not needed" cards (issue #158 part A).
--
-- The suggestion inbox page (admin desk #/admin/suggestions) lists the tN note
-- kinds (tn_rows.support_reference) editors keep marking Not needed, computed
-- from edit_log when an admin opens it (api/src/notNeededKinds.ts). It stores
-- nothing except this: the kinds an admin dismissed, so a dismissed kind is
-- never listed again in this workspace. Dismissing switches nothing off.
--
-- support_reference is the bare tA id ("figs-yousingular"), the same short form
-- the page shows, whether the rows store the full rc:// link or the bare id.
-- Additive only.

CREATE TABLE IF NOT EXISTS not_needed_kind_dismissals (
  support_reference  TEXT PRIMARY KEY,
  dismissed_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  dismissed_by       INTEGER
);
