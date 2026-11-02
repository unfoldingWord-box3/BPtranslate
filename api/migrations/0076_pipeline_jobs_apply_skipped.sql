-- What an AI translate apply left alone (issue #601, option B): notes a person
-- edited, approved, marked Not needed or restored after the job was queued.
-- JSON {"tnTouched": N, "tnTouchedIds": [...]}, NULL when nothing was skipped.
-- Written by pipelineImport.ts applyJobOutput; read by GET /api/pipelines and
-- GET /api/pipelines/:jobId. output_json stays the bot's own output.
--
-- Plain additive column: no rebuild, no data rewrite.
ALTER TABLE pipeline_jobs ADD COLUMN apply_skipped_json TEXT;

-- The highest edit_log.id when the job was queued (issue #601). edit_log.id is
-- INTEGER PRIMARY KEY AUTOINCREMENT, so it orders every audit row exactly; a
-- note "touched after the job was queued" is one with a human edit_log row
-- whose id is above this. Seconds can't separate an edit just before the
-- enqueue from one just after. Computed inside the job's INSERT (pipelines.ts),
-- so no edit can commit between the read and the insert; a follow-up or chain
-- child inherits its parent's value. NULL on jobs queued before this column
-- existed: their apply falls back to comparing edit_log.created_at with
-- pipeline_jobs.created_at.
ALTER TABLE pipeline_jobs ADD COLUMN edit_log_watermark INTEGER;
