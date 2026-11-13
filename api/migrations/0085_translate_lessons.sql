-- 0085: nightly lessons from editor corrections (issue #817, part 1).
--
-- Each night, for a workspace that has switched this on, the Worker reads what
-- editors changed in the AI translation-note drafts they approved, asks the
-- workspace's own AI model once for a short list of "lessons", and renders that
-- list into the context pack's instructions.md (api/src/lessons.ts,
-- api/src/contextExport.ts). Additive only: three new tables, nothing existing
-- is touched.
--
-- lesson_settings  the per-workspace (= per database) on/off switch. NO ROW
--                  MEANS OFF: every workspace starts off until an admin turns it
--                  on (Benjamin's decision on #817, 2026-11-12), because every
--                  run spends the partner's own AI account.
-- lesson_runs      one row per night the job got past its checks: the edit_log
--                  watermark it covered, what it found, and what the AI call
--                  cost (NULL cost = no price known, not $0). `night` is UNIQUE
--                  so two invocations on one UTC day make one call.
--                  status: running | ok | no_changes | failed.
-- lessons          the full lesson set a successful (status 'ok') run wrote,
--                  keyed by that run, so each night's set stays restorable.
--                  The current set is the one from the newest 'ok' run.

CREATE TABLE IF NOT EXISTS lesson_settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  enabled     INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by  INTEGER
);

CREATE TABLE IF NOT EXISTS lesson_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  night              TEXT NOT NULL UNIQUE,
  started_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at        INTEGER,
  status             TEXT NOT NULL DEFAULT 'running',
  failure_reason     TEXT,
  approvals_through  INTEGER NOT NULL,
  chapters_json      TEXT NOT NULL DEFAULT '[]',
  changes            INTEGER NOT NULL DEFAULT 0,
  provider           TEXT,
  model              TEXT,
  calls              INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL
);

CREATE TABLE IF NOT EXISTS lessons (
  run_id          INTEGER NOT NULL REFERENCES lesson_runs(id),
  position        INTEGER NOT NULL,
  lesson          TEXT NOT NULL,
  example_before  TEXT NOT NULL DEFAULT '',
  example_after   TEXT NOT NULL DEFAULT '',
  evidence        INTEGER NOT NULL DEFAULT 0,
  first_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (run_id, position)
);

-- The job's two edit_log reads (newest approval, most recently approved
-- chapters) look only at tN 'validate' entries; without this they scan the
-- whole log, which gains a row per saved keystroke.
CREATE INDEX IF NOT EXISTS edit_log_kind_action ON edit_log(kind, action, id);
