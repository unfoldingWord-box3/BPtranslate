-- Diagnostic log of rejected row writes (409 version_mismatch).
--
-- A rejected PATCH/DELETE writes nothing to edit_log, so when a translator saw
-- "Another editor changed this note" on 2026-10-03 the server had no record of
-- the attempt: not which note, not which version the browser sent, not how old
-- the queued op was. This table is that record. It is append-only diagnostics,
-- never read by the app, and safe to prune.
--
--   expected_version  the If-Match the client sent
--   current_version   the row's version at the moment of the 409
--   current_updated_by / current_updated_at  who/when wrote that version
--   fields_json       the patched column names (not values; notes can be long)
--   op_queued_at      client outbox enqueue time (ms epoch), from
--                     X-Op-Queued-At — hours-old means a leftover op from an
--                     earlier session, seconds-old means a live save
--   client_route      the SPA hash route of the tab that sent it, from
--                     X-Client-Route (e.g. "#/notes") — the drain tab, which
--                     may differ from the tab that queued the op
--   tab_id            random per-page-load id, from X-Tab-Id — two ids for one
--                     user in the same minute means two tabs were open
--
-- Plain additive CREATE: no rebuild, no FK involvement, no preflight needed.
CREATE TABLE row_conflict_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  kind TEXT NOT NULL,
  row_id TEXT NOT NULL,
  book TEXT,
  action TEXT NOT NULL,                 -- 'patch' | 'delete'
  user_id INTEGER,
  expected_version INTEGER,
  current_version INTEGER,
  current_updated_by INTEGER,
  current_updated_at INTEGER,
  fields_json TEXT,
  op_queued_at INTEGER,
  client_route TEXT,
  tab_id TEXT
);
CREATE INDEX row_conflict_log_recent ON row_conflict_log(created_at DESC);
CREATE INDEX row_conflict_log_row ON row_conflict_log(kind, row_id);
