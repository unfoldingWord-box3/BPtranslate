-- 0086: nightly lessons (issue #817) — mark a run that ran out of its mining
-- budget before it compared every new approval in its chapters.
--
-- The next run then finishes that run's chapters (lesson_runs.chapters_json)
-- before it moves on to the newest ones, so a night that ran out of time loses
-- nothing when editors move to another chapter in between (api/src/lessons.ts).
-- Additive only: one new column with a default; no row is rewritten.

ALTER TABLE lesson_runs ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;
