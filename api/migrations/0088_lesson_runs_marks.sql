-- 0088: nightly lessons (issue #915) — per-chapter progress next to the one
-- approvals watermark.
--
-- lesson_runs.marks_json   NULL, or a JSON array of {book, chapter, through}:
--                          the chapters whose hand approvals are mined through
--                          a different edit_log id than the run's
--                          approvals_through. Above it: a resumed chapter
--                          finished past the watermark (its approvals are not
--                          new again). Below it: a newest chapter a resume
--                          left for later (its approvals are still new).
--                          Any chapter not listed is mined through
--                          approvals_through, as before (api/src/lessons.ts).
--
-- Additive only: one new nullable column; no row is rewritten.

ALTER TABLE lesson_runs ADD COLUMN marks_json TEXT;
