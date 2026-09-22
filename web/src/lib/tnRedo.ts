// Shared gating for the flows Translate Notes "Redo" verb.
//
// Old Testament verse notes use the quote-anchored tn-quick path
// (support_reference + quote required). Two kinds of row retranslate through
// the existing single-row translate pipeline instead (same path classic
// NoteCard "Re-run" already uses):
//   * intro/general notes (`verse === 0`) — no quote or support ref (#300);
//   * New Testament verse notes — the bot's tn-quick drafter only loads the
//     Hebrew Bible (UHB), so every NT verse answers 503 `uhb_missing_for_verse`
//     before the model is called (BSOJ on LUK, 2026-09-14; bot-side Greek
//     support tracked in unfoldingWord/bp-assistant#394).

import { isHebrewBook } from "./testament.ts";

export type TnRedoRow = {
  verse: number;
  support_reference?: string | null;
  quote?: string | null;
};

export function isIntroTnRow(row: Pick<TnRedoRow, "verse">): boolean {
  return row.verse === 0;
}

/**
 * True when Redo should start a translate pipeline job rather than tn-quick:
 * intro rows, and any verse note in a New Testament book (tn-quick has no
 * Greek source text — see the header). An unknown book keeps the tn-quick path.
 */
export function tnRedoUsesPipeline(
  row: Pick<TnRedoRow, "verse">,
  book?: string | null,
): boolean {
  return isIntroTnRow(row) || !isHebrewBook(book);
}

// Escape hatch for intro Redo: a fresh single-row translate rarely needs this
// long, but the spinner must not stick forever if onComplete never fires.
export const INTRO_REDO_TIMEOUT_MS = 15 * 60 * 1000;

// When a row-scoped intro Redo is answered `already_running`, pipelineStore.start
// latched onto a broader in-flight translate rather than starting a fresh
// single-row run: per #347 item 1, a covering chapter-wide job is returned with
// its own id. Chapter runs are documented as ~1h (pipelineStore header), so the
// 15-minute budget would flip a perfectly healthy run to a false `timeout`
// failure (#376). Give the shared job a chapter-run-sized budget instead.
export const CHAPTER_REDO_TIMEOUT_MS = 90 * 60 * 1000;

/**
 * Stuck-spinner budget (ms) for an intro Redo, chosen from how
 * `pipelineStore.start` answered. An `already_running` answer means we're
 * waiting on a broader job already in flight (chapter-wide, documented ~1h), so
 * a fresh-run 15-minute timeout would misreport a healthy run as `timeout`
 * (#376). Every other status keeps the short single-row budget.
 */
export function introRedoTimeoutMs(
  startStatus: "running" | "queued" | "already_running",
): number {
  return startStatus === "already_running"
    ? CHAPTER_REDO_TIMEOUT_MS
    : INTRO_REDO_TIMEOUT_MS;
}

// Error codes returned by the tn-quick proxy / translate pipeline when AI
// drafting is genuinely NOT CONFIGURED for this workspace (no BT_API_TOKEN, no
// Anthropic key, pipeline route disabled). These are the ONLY errors that may
// latch Redo off for the whole session — they never un-set themselves mid-run.
//
// A bare HTTP status is deliberately NOT on this list. The proxy forwards an
// overloaded bot's 503 (or a relayed Anthropic 529) verbatim, so a transient
// upstream hiccup arrives as `status === 503` too — indistinguishable by status
// from the "no token" case, but temporary. Latching on the status flattened
// both together, disabling Redo for the session on one hiccup with only a faint
// caption to explain it (the "greyed out and nothing happened" report). Match on
// the explicit code instead: the real "no token" case still carries
// `tn_quick_disabled`, and everything else stays a retryable failure.
export const AI_UNCONFIGURED_CODES: ReadonlySet<string> = new Set([
  "tn_quick_disabled",
  "anthropic_api_key_missing",
  "pipeline_api_disabled",
]);

/**
 * True when a Redo error means AI drafting is not configured (a permanent,
 * session-sticky condition that greys the button), as opposed to a transient
 * upstream failure that should stay retryable.
 */
export function redoErrorIsAiUnconfigured(code: string | null | undefined): boolean {
  return code != null && AI_UNCONFIGURED_CODES.has(code);
}

export function tnRedoBlockedReason(
  row: TnRedoRow | null | undefined,
  book: string | null | undefined,
  opts: {
    aiUnavailable: string | null;
    noNoteSelected: string;
    needsSupportRef: string;
    needsQuote: string;
  },
): string | null {
  if (opts.aiUnavailable) return opts.aiUnavailable;
  if (!row) return opts.noNoteSelected;
  // Pipeline rows (intros, NT verse notes) skip quote/supportRef — the
  // pipeline retranslates the source note, so tn-quick's anchors aren't needed.
  if (tnRedoUsesPipeline(row, book)) return null;
  if (!row.support_reference) return opts.needsSupportRef;
  if (!row.quote) return opts.needsQuote;
  return null;
}
