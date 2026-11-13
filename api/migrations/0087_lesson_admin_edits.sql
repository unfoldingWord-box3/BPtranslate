-- 0087: nightly lessons part 2 (issue #908) — an admin can delete, pin,
-- promote (to Common issues) and restore lessons.
--
-- Every admin change writes a NEW lesson set, so history stays restorable: a
-- lesson_runs row with status 'edited' (no AI call, no mining) holding the
-- whole set in `lessons`, exactly like a night's 'ok' run. The current set is
-- the newest 'ok' or 'edited' row (api/src/lessonsRender.ts). The nightly
-- job's watermark and resume reads keep filtering on 'ok' / 'no_changes', so
-- an edit never moves them. `night` is UNIQUE; an edit row stores
-- 'edit:<uuid>', which never collides with a night's UTC date.
--
-- lesson_runs.action        NULL for a night's run; for an 'edited' row:
--                           delete | pin | unpin | promote | restore.
-- lesson_runs.edited_by     the admin's user id ('edited' rows only).
-- lesson_runs.based_on      the set the edit started from (for restore: the
--                           set restored).
-- lessons.pinned            1 = kept by every nightly merge as it is, never
--                           dropped as reversed and never trimmed.
-- lesson_deletions          one row per deleted lesson. A night does not
--                           bring a deleted lesson back (same wording or same
--                           example) unless a note approved after the delete
--                           shows that example's change again.
--
-- Additive only: three nullable/defaulted columns and one new table.

ALTER TABLE lesson_runs ADD COLUMN action TEXT;
ALTER TABLE lesson_runs ADD COLUMN edited_by INTEGER;
ALTER TABLE lesson_runs ADD COLUMN based_on INTEGER;
ALTER TABLE lessons ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS lesson_deletions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson             TEXT NOT NULL,
  example_before     TEXT NOT NULL DEFAULT '',
  example_after      TEXT NOT NULL DEFAULT '',
  deleted_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_by         INTEGER,
  -- The newest hand approval (edit_log id) when the lesson was deleted.
  approvals_through  INTEGER NOT NULL DEFAULT 0
);
