-- In-app help assistant (POST /api/help/ask). Additive only.
--
-- help_chat_usage: per user per UTC day spend against the daily cap.
-- spent_micros    — settled cost in micro-dollars (1 USD = 1,000,000).
-- reserved_micros — worst-case cost of calls currently in flight; counted
--                   against the cap so two racing tabs can't both pass.
-- calls           — calls that day that returned an answer.
CREATE TABLE help_chat_usage (
  user_id         INTEGER NOT NULL,
  day             TEXT    NOT NULL,   -- UTC YYYY-MM-DD
  spent_micros    INTEGER NOT NULL DEFAULT 0,
  reserved_micros INTEGER NOT NULL DEFAULT 0,
  calls           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- help_chat_settings: the admin on/off switch. Its own single-row table, NOT a
-- column on ai_provider_config: a row there would bump the provider config's
-- version counter and make the AI key form's first save (If-Match: 0) 409.
-- Off until an org admin turns it on.
CREATE TABLE help_chat_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  enabled    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by INTEGER
);
