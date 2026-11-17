// Extract the server's current TranslationPrefs row from a translation-memory
// prefs PUT's 409 (version_mismatch) body, if present. Pure so it can be unit
// tested without the api/fetch layer (see prefsConflict.test.mjs).
//
// Why this exists: PreferencesWorkspace sections (brief / instructions /
// common issues) share one TranslationPrefs version. A 409 means another
// section (or another admin) saved first; the response body carries the
// server's fresh row (`current`) so the caller can adopt it directly via
// `apply()` instead of refetching — refetching would race with, and could
// clobber, whatever the user is still typing in the section that 409'd.

import type { TranslationPrefs } from "./api";

export function currentPrefsFromConflict(body: unknown): TranslationPrefs | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.error !== "version_mismatch") return null;
  const current = b.current;
  if (!current || typeof current !== "object") return null;
  const c = current as Record<string, unknown>;
  if (typeof c.version !== "number") return null;
  return current as TranslationPrefs;
}

// The server's row after a prefs PUT's 409: the body's `current`, else
// fetched with `fetchCurrent`, so the editor can rebase its draft either way
// (a body without `current` used to leave the draft on its old base, and
// every later Save 409ed again; #909 gate review H3). null when the fetch
// fails too.
export async function prefsConflictRow(
  body: unknown,
  fetchCurrent: () => Promise<TranslationPrefs>,
): Promise<TranslationPrefs | null> {
  const current = currentPrefsFromConflict(body);
  if (current) return current;
  try {
    return await fetchCurrent();
  } catch {
    return null;
  }
}
