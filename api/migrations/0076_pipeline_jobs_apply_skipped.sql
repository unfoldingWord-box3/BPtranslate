-- What an AI translate apply left alone (issue #601, option B): notes a person
-- edited, approved, marked Not needed or restored after the job was queued.
-- JSON {"tnTouched": N, "tnTouchedIds": [...]}, NULL when nothing was skipped.
-- Written by pipelineImport.ts applyJobOutput; read by GET /api/pipelines and
-- GET /api/pipelines/:jobId. output_json stays the bot's own output.
--
-- Plain additive column: no rebuild, no data rewrite.
ALTER TABLE pipeline_jobs ADD COLUMN apply_skipped_json TEXT;
