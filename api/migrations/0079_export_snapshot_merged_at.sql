-- What an export snapshot covers, and when it reached the base branch (master)
-- on Door43 (issue #679).
--
-- An export commits to a per-book `-be-` branch and opens a PR; Door43's own
-- validate-and-merge workflow merges it into master later, outside this app.
-- AI translate runs read master, so "exported" is not "visible to the AI".
-- The unpublished-Bible-text check (api/src/unpublishedScripture.ts) reads
-- both columns. Additive; nothing else reads them.
--
--   merged_at            unix seconds the snapshot's PR merged, recorded by
--                        that check once it asks Door43. NULL = not known to
--                        be merged.
--   edit_log_watermark   MAX(edit_log.id) read just before the export read D1
--                        to render. Every edit with a higher id may be missing
--                        from this export, even one made before committed_at
--                        (which is stamped after the render and the Door43
--                        round trips). NULL on rows from before this column;
--                        the check falls back to committed_at for those.
ALTER TABLE export_snapshots ADD COLUMN merged_at INTEGER;
ALTER TABLE export_snapshots ADD COLUMN edit_log_watermark INTEGER;
