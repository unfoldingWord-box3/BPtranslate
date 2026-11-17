// The edit_log entry for one Translation-preferences save (issue #786). A
// leaf module: translationMemory.ts (PUT /prefs) and lessons.ts (promote a
// lesson to Common issues, #908) both write it, and lessons.ts cannot import
// translationMemory.ts (that file mounts the lessons routes).
//
// One edit_log entry per successful save (issue #786): kind 'prefs', row_key
// '1' (the singleton), book NULL; source is editSource(c), so 'chat' for the
// chat assistant and NULL for the web app. Batched after the write it audits
// and gated on changes(), so a lost CAS or first-write race records nothing.
// Every edit_log reader filters on kind (tn/tq/twl/verse/tw/ta/template), so
// these entries change nothing they compute; the retention sweep in index.ts
// skips kind 'prefs' so the trail outlives 180 days.
// ?1 user, ?2 prev_version, ?3 action, ?4 source, ?5 payload.
export const PREFS_HISTORY_SQL = `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, payload_json)
  SELECT 'prefs', '1', NULL, ?1, ?2, ?2 + 1, ?3, ?4, ?5
   WHERE (SELECT changes()) > 0`;
