-- In-app help assistant (POST /api/help/ask). Additive only.
--
-- help_chat_usage: per user per UTC day spend against the daily cap.
-- spent_micros    — settled cost in micro-dollars (1 USD = 1,000,000).
-- reserved_micros — worst-case cost of calls currently in flight; counted
--                   against the cap so two racing tabs can't both pass.
-- calls           — settled calls that day.
CREATE TABLE help_chat_usage (
  user_id         INTEGER NOT NULL,
  day             TEXT    NOT NULL,   -- UTC YYYY-MM-DD
  spent_micros    INTEGER NOT NULL DEFAULT 0,
  reserved_micros INTEGER NOT NULL DEFAULT 0,
  calls           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Off until an org admin turns it on.
ALTER TABLE ai_provider_config ADD COLUMN help_chat_enabled INTEGER NOT NULL DEFAULT 0;
