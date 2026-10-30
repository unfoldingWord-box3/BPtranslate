-- Chat assistant account links (issue #669). A reviewer signed into the web
-- app gets a one-time code, types it into the chat (BT Servant on WhatsApp or
-- Telegram), and the MCP endpoint trades it for a session token the bot keeps
-- in that user's memory and sends back with each call.
--
-- Read and written through sharedDb() like users and sessions, so a link
-- survives workspace switches. Each row is still bound to ONE workspace slug:
-- a token is refused on any other workspace's MCP URL.
--
-- Only SHA-256 hashes of codes and tokens are stored, never the values.

CREATE TABLE chat_link_codes (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  workspace_slug TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER
);
CREATE INDEX chat_link_codes_user ON chat_link_codes(user_id);

CREATE TABLE chat_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  workspace_slug TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX chat_links_user ON chat_links(user_id);
