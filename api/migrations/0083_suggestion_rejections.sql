-- 0083: rejected suggestion-inbox cards (issue #819).
--
-- The suggestion inbox (api/src/suggestionInbox.ts, admin desk #/admin/suggestions)
-- groups repeated word-level corrections editors made to AI translation-note
-- drafts. It is computed when an admin opens it and stores nothing, except this:
-- the cards an admin rejected, so a rejected change is never suggested again in
-- this workspace. Approving a house-style card writes a house_style_rules row
-- (migration 0082), not a row here.
--
-- key is the card's change key, the JSON array [change, before, after]
-- (change is "change", "insert" or "insert-end"; before/after are NFC text).
-- before_text / after_text repeat the key's text for anyone reading the table.
-- Additive only.

CREATE TABLE IF NOT EXISTS suggestion_rejections (
  key          TEXT PRIMARY KEY,
  before_text  TEXT NOT NULL,
  after_text   TEXT NOT NULL,
  rejected_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  rejected_by  INTEGER
);
