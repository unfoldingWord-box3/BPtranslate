-- One context export at a time per workspace (issues #716, #722).
--
-- The context pack ({org}/translation-context on Door43) is written without a
-- base-commit check, so two exports running at once could fail for good or
-- leave an older pack on top of a newer one. This row serializes them:
--
--   holder / lease_until   the Workflow instance running the export, and when
--                          its claim runs out (unix seconds). A run that died
--                          without releasing is taken over once lease_until
--                          passes, so the queue cannot stay stuck.
--   pending                1 = a save happened that no started run has read yet.
--                          A run clears it when it starts (before reading D1);
--                          a save during the run sets it again, and the run
--                          then starts exactly one follow-up when it finishes.
--   shrink_override        an admin's shrink-guard override waiting for the next
--                          run (set when the override run had to wait).
--   holder_shrink_override the override the current holder took with it.
--
-- Written only by api/src/contextExportQueue.ts.

CREATE TABLE context_export_lock (
  workspace TEXT PRIMARY KEY,
  holder TEXT,
  lease_until INTEGER,
  pending INTEGER NOT NULL DEFAULT 0,
  shrink_override INTEGER NOT NULL DEFAULT 0,
  holder_shrink_override INTEGER NOT NULL DEFAULT 0,
  requested_at INTEGER,
  started_at INTEGER
);
