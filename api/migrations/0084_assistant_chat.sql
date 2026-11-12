-- In-app editing assistant (POST /api/assistant/chat, issue #858). Additive
-- only. Same shape as the help assistant's tables (0077) but its own budget,
-- so spending one assistant never uses up the other's daily cap.
--
-- assistant_chat_usage: per user per UTC day spend against the daily cap.
-- spent_micros    — settled cost in micro-dollars (1 USD = 1,000,000).
-- reserved_micros — worst-case cost of calls currently in flight; counted
--                   against the cap so two racing tabs can't both pass.
-- calls           — calls that day that returned an answer.
CREATE TABLE assistant_chat_usage (
  user_id         INTEGER NOT NULL,
  day             TEXT    NOT NULL,   -- UTC YYYY-MM-DD
  spent_micros    INTEGER NOT NULL DEFAULT 0,
  reserved_micros INTEGER NOT NULL DEFAULT 0,
  calls           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- assistant_chat_settings: the admin on/off switch. Its own single-row table
-- for the same reason as help_chat_settings: a row on ai_provider_config would
-- bump its version counter and 409 the AI key form's first save.
-- Off until an org admin turns it on.
CREATE TABLE assistant_chat_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  enabled    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by INTEGER
);
