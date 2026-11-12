-- One "Draft missing templates from approved notes" run at a time (#818).
--
-- Each run calls the org's AI model once per note type and bills the org's own
-- key, so two runs started together (two admins, two tabs, a re-press after
-- the browser gave up waiting) would pay twice for the same drafts. This
-- single row is the lease:
--
--   holder       a random id for the run holding it (NULL = free)
--   lease_until  when the claim runs out (unix seconds). A run that died
--                without releasing is taken over once this passes.
--
-- Written only by api/src/templateDraftMissing.ts. Additive: older code never
-- reads it.

CREATE TABLE template_draft_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT,
  lease_until INTEGER
);
