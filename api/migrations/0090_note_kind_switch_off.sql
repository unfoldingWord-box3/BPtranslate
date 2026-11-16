-- 0090: switch a whole tN note kind off for this project, and back on (#924,
-- the second part of #158). See api/src/noteKindSwitch.ts for the rules.
--
-- A switched-off note is hidden the way every other read already hides a
-- deleted note: its deleted_at is set. switched_off_kind is its own mark on top
-- of that, naming the kind whose switch-off hid it, so Switch back on restores
-- exactly those notes and nothing deleted any other way. Code from before this
-- migration sees only deleted_at, so a code rollback keeps the notes hidden.
--
-- switch_restored_at: set when Switch back on restores a note, cleared once the
-- DCS reimport sees master carry it again. Until then the reimport's prune
-- (softDeleteRemovedTsvRows) must not delete it as "removed on master": master
-- lacks it only because tonight's export has not put it back yet.
--
-- note_kinds_switched_off: the kinds switched off now. Imports and reimports
-- hide new notes of these kinds as they land.
--
-- Additive only: two nullable columns, one table, one partial index.

ALTER TABLE tn_rows ADD COLUMN switched_off_kind TEXT;
ALTER TABLE tn_rows ADD COLUMN switch_restored_at INTEGER;

CREATE INDEX IF NOT EXISTS tn_rows_switched_off_kind
  ON tn_rows(switched_off_kind) WHERE switched_off_kind IS NOT NULL;

CREATE TABLE IF NOT EXISTS note_kinds_switched_off (
  kind             TEXT PRIMARY KEY,
  switched_off_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  switched_off_by  INTEGER
);
