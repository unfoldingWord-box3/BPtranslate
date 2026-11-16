// Switch a tN note kind off for this project, and back on (issue #924, the
// second part of #158; migration 0090). Benjamin chose "undo any time".
//
// The routes live in suggestionInbox.ts, next to the part A list:
//   POST /api/suggestion-inbox/not-needed-kinds/switch-off  {kind}  (admin only)
//   POST /api/suggestion-inbox/not-needed-kinds/switch-on   {kind}  (admin only)
//   GET  /api/suggestion-inbox/not-needed-kinds lists the kinds switched off.
//
// The rules, exactly (the help and the page say them in plain words):
//
//   kind     a bare tA id ("figs-yousingular"). A note is of that kind when
//            shortSupport(support_reference) equals it: the trimmed value is
//            the id, or ends in "/" + the id (the rc:// link form).
//   hide     every note of the kind, in every book, that is live: not deleted
//            and not in the trash (a trashed note keeps its own path, and the
//            nightly finalize deletes it as usual). Hiding sets deleted_at, so
//            every read, count and the export already leave it out, and the
//            nightly finalize (which reads trashed_at only) never touches it;
//            switched_off_kind marks which switch-off hid it. Each hidden note
//            gets one edit_log row, action 'switch_off'.
//   restore  Switch back on clears deleted_at on exactly the notes whose mark
//            names the kind, and logs 'switch_on' for each. A note deleted
//            before the switch-off, or by someone else, has no mark and stays
//            deleted. switch_restored_at keeps the reimport's prune off a
//            restored note until master carries it again (see bookReimport.ts
//            softDeleteRemovedTsvRows).
//   new notes  while a kind is switched off, each import, reimport, AI
//            pipeline apply and the nightly tick hide new live notes of it
//            (hideSwitchedOffKinds), so a reimport cannot bring the kind back.
//            Notes are marked, not skipped, so Switch back on restores them too.
//
// Neither hide nor restore changes version, updated_by or updated_at: like
// trash, it is a reversible state flip, not an edit of the note. A stale tab
// cannot write to a hidden note, because every by-id write in rows.ts refuses
// a row with deleted_at set.
//
// Both statements of each change run in one D1 batch (one transaction), the
// audit INSERT first so it reads the rows before the UPDATE changes them, as the
// nightly finalize does (api/src/index.ts). Set-based, so a kind with thousands
// of notes is still two statements.

import type { Env } from "./index";

type Db = Env["DB"];

export const SWITCH_SOURCE = "note_kind_switch";

/** A bare tA id: no spaces or slashes. */
export function isNoteKind(kind: string): boolean {
  return kind.length > 0 && kind.length <= 100 && /^[^\s/]+$/.test(kind);
}

// shortSupport(support_reference) = kind, in SQL. ?1 is the kind.
const KIND_MATCH = `(TRIM(support_reference) = ?1 OR substr(TRIM(support_reference), -(length(?1) + 1)) = '/' || ?1)`;
const LIVE = `deleted_at IS NULL AND trashed_at IS NULL`;

const tableMissing = (err: unknown) =>
  err instanceof Error && /no such (table|column):\s*(note_kinds_switched_off|switched_off_kind|switch_restored_at)/i.test(err.message);

export interface SwitchedOffKind {
  kind: string;
  /** Notes hidden by this switch-off now. */
  hidden: number;
  switchedOffAt: number;
}

/** The kinds switched off now, or null when migration 0090 is missing. */
export async function listSwitchedOffKinds(db: Db): Promise<SwitchedOffKind[] | null> {
  try {
    const rs = await db
      .prepare(
        `SELECT k.kind, k.switched_off_at,
                (SELECT COUNT(*) FROM tn_rows t
                  WHERE t.switched_off_kind = k.kind AND t.deleted_at IS NOT NULL) AS hidden
           FROM note_kinds_switched_off k
          ORDER BY k.kind`,
      )
      .all<{ kind: string; switched_off_at: number; hidden: number }>();
    return (rs.results ?? []).map((r) => ({ kind: r.kind, hidden: Number(r.hidden), switchedOffAt: Number(r.switched_off_at) }));
  } catch (err) {
    if (tableMissing(err)) return null;
    throw err;
  }
}

// The two statements that hide the live notes of one kind (optionally in one
// book). ?1 kind, ?2 now, ?3 book (when given), ?4 user id (audit only).
function hideStatements(db: Db, kind: string, now: number, userId: number | null, book: string | null) {
  const where = `${KIND_MATCH} AND ${LIVE}${book ? " AND book = ?3" : ""}`;
  return [
    db
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, payload_json)
         SELECT 'tn', id, book, ?4, version, version, 'switch_off', '${SWITCH_SOURCE}', json_object('kind', ?1, 'at', ?2)
           FROM tn_rows WHERE ${where}`,
      )
      .bind(kind, now, book, userId),
    db
      .prepare(`UPDATE tn_rows SET deleted_at = ?2, switched_off_kind = ?1, switch_restored_at = NULL WHERE ${where}`)
      .bind(...(book ? [kind, now, book] : [kind, now])),
  ];
}

/**
 * Switch a kind off: record it, hide its live notes in every book.
 * Returns how many notes were hidden. Throws "not_migrated" without 0090.
 */
export async function switchOffKind(db: Db, kind: string, userId: number | null, now = Math.floor(Date.now() / 1000)): Promise<{ hidden: number }> {
  try {
    const [, , update] = await db.batch([
      db
        .prepare(`INSERT OR IGNORE INTO note_kinds_switched_off (kind, switched_off_at, switched_off_by) VALUES (?1, ?2, ?3)`)
        .bind(kind, now, userId),
      ...hideStatements(db, kind, now, userId, null),
    ]);
    return { hidden: Number(update?.meta?.changes ?? 0) };
  } catch (err) {
    if (tableMissing(err)) throw new Error("not_migrated");
    throw err;
  }
}

/**
 * Switch a kind back on: forget it, restore exactly the notes its switch-off
 * hid. Returns how many were restored, or null when the kind is not switched
 * off and no note carries its mark. Throws "not_migrated" without 0090.
 */
export async function switchOnKind(db: Db, kind: string, userId: number | null, now = Math.floor(Date.now() / 1000)): Promise<{ restored: number } | null> {
  const where = `switched_off_kind = ?1 AND deleted_at IS NOT NULL`;
  try {
    const known = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM note_kinds_switched_off WHERE kind = ?1)
              + (SELECT COUNT(*) FROM tn_rows WHERE ${where}) AS n`,
      )
      .bind(kind)
      .first<{ n: number }>();
    if (!known || Number(known.n) === 0) return null;
    const [, update] = await db.batch([
      db
        .prepare(
          `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, payload_json)
           SELECT 'tn', id, book, ?3, version, version, 'switch_on', '${SWITCH_SOURCE}', json_object('kind', ?1, 'at', ?2)
             FROM tn_rows WHERE ${where}`,
        )
        .bind(kind, now, userId),
      db
        .prepare(`UPDATE tn_rows SET deleted_at = NULL, switched_off_kind = NULL, switch_restored_at = ?2 WHERE ${where}`)
        .bind(kind, now),
      db.prepare(`DELETE FROM note_kinds_switched_off WHERE kind = ?1`).bind(kind),
    ]);
    return { restored: Number(update?.meta?.changes ?? 0) };
  } catch (err) {
    if (tableMissing(err)) throw new Error("not_migrated");
    throw err;
  }
}

/**
 * Hide new live notes of every switched-off kind, in one book or all books.
 * Called after imports, reimports, AI pipeline applies and by the nightly tick
 * (before the export), so no path brings a switched-off kind back. Returns the
 * number hidden. Never throws: a failure here must not fail the import that
 * called it (the nightly tick retries), so it logs and returns 0.
 */
export async function hideSwitchedOffKinds(db: Db, opts: { book?: string } = {}): Promise<number> {
  try {
    const rs = await db.prepare(`SELECT kind FROM note_kinds_switched_off`).all<{ kind: string }>();
    const kinds = (rs.results ?? []).map((r) => r.kind);
    if (kinds.length === 0) return 0;
    const now = Math.floor(Date.now() / 1000);
    const results = await db.batch(kinds.flatMap((k) => hideStatements(db, k, now, null, opts.book ?? null)));
    let hidden = 0;
    for (let i = 1; i < results.length; i += 2) hidden += Number(results[i]?.meta?.changes ?? 0);
    if (hidden > 0) console.log("switched-off note kinds: hid new notes", { book: opts.book ?? "*", hidden });
    return hidden;
  } catch (err) {
    if (!tableMissing(err)) {
      console.error("switched-off note kinds: hiding new notes failed", err instanceof Error ? err.message : String(err));
    }
    return 0;
  }
}
