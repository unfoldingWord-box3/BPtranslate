// Helpers shared by the translator queue screens (TranslateNotesScreen,
// TranslateQuestionsScreen). Extracted verbatim from TranslateNotesScreen so
// both screens run the identical save-settlement logic — this file changes no
// behaviour, it only stops the two screens from drifting apart.

import { onOutboxResult, type OutboxResult } from "../../sync/outbox";

export { escapeNewlines, unescapeNewlines } from "../../lib/tsvNewlines";

// Distinct provenance: a row whose draft text came from an Aquifer import
// (draft_meta_json.source === "aquifer"), not from the AI translate bot. Kept in
// draft_meta_json so it survives the D1 round-trip. This is provenance ONLY — it
// does not encode the row's translation_state; callers combine it with their own
// state check. The single implementation shared by the classic NoteCard badge
// and the flow translate screens so the two can't drift (issue #295).
export function isAquiferDraftRow(
  row: { draft_meta_json?: string | null } | null | undefined,
): boolean {
  try {
    return JSON.parse(row?.draft_meta_json ?? "null")?.source === "aquifer";
  } catch {
    return false;
  }
}

// Wait for one outbox op to settle. "retry" is not a settlement — the op is
// still in flight and will be dispatched again. Resolves null on timeout (a
// read-only/frozen lane returns a no-op op that never settles), so the caller
// can say so honestly instead of assuming the save landed.
export function waitForOp(opId: string, timeoutMs = 20_000): Promise<OutboxResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    let off: (() => void) | null = null;
    const finish = (result: OutboxResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off?.();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    off = onOutboxResult((op, result) => {
      if (op.id !== opId || result.kind === "retry") return;
      finish(result);
    });
  });
}
