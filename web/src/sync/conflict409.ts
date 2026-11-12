// How the outbox reads a 409 on a save (issue #883 item 6), and two rules for
// the expected_state pin the Rapid check assistant's Apply sends (#880).
// Pure, with no import of api.ts, so the strip-types test runner can load it
// (conflict409.test.mjs). A chapter_locked 409 is not handled here: dispatch
// checks it first with api.ts's isChapterLockedBody.

export type Result409 =
  | { kind: "conflict"; current: unknown }
  | { kind: "retry"; reason: string }
  // `current` is set for state_mismatch only: the row as the server holds it.
  | { kind: "fatal"; reason: string; current?: unknown };

function unexpectedAlignmentLossReason(body: unknown): string | null {
  const error = (body as { error?: unknown } | null)?.error;
  if (error !== "unexpected_alignment_loss") return null;
  const losses = (body as { delta?: { unexpectedLosses?: unknown[] } } | null)
    ?.delta?.unexpectedLosses;
  const sample = Array.isArray(losses)
    ? losses
        .slice(0, 3)
        .map((loss) => (loss as { text?: unknown } | null)?.text)
        .filter((text): text is string => typeof text === "string" && text.length > 0)
        .join(", ")
    : "";
  return `unexpected_alignment_loss${sample ? `: ${sample}` : ""}`;
}

/** The outbox result for a 409 whose body is not chapter_locked. */
export function resultFor409(body: unknown): Result409 {
  const alignmentLoss = unexpectedAlignmentLossReason(body);
  if (alignmentLoss) return { kind: "fatal", reason: alignmentLoss };
  const errCode = (body as { error?: string } | null | undefined)?.error;
  if (errCode === "workspace_mismatch") {
    // This tab's X-Workspace header (its own notion of the active org) no
    // longer matches the workspace the server resolved the request against —
    // a SIBLING tab switched orgs out from under it (see api.ts's request()
    // and workspaces.ts's requireWorkspaceMatch). This is NOT a version
    // conflict: don't surface a merge prompt, don't burn the retry-attempt
    // cap (reason doesn't start with "transient"). The op still belongs to —
    // and is valid against — the OTHER workspace's outbox database; leave it
    // queued as-is. Once api.ts's reload lands the user back where their
    // outbox agrees with the server, it drains normally.
    return { kind: "retry", reason: "workspace_mismatch" };
  }
  // A row patch's expected_state no longer matches (#880): the note changed
  // since the edit was proposed. Resending (or the auto-heal a
  // version_mismatch gets) cannot help, and no typing is held: only the
  // assistant's Apply pins a state. The row comes along so the screen can
  // show it (#883 item 1).
  if (errCode === "state_mismatch") {
    return { kind: "fatal", reason: errCode, current: (body as { current?: unknown }).current };
  }
  // Lane-specific terminal errors: the verse's generation is stale or a
  // replacement is active — retrying won't help; quarantine immediately.
  if (
    errCode === "source_generation_mismatch" ||
    errCode === "lane_replacement_required" ||
    errCode === "lane_replacement_in_progress" ||
    errCode === "scripture_text_read_only" ||
    errCode === "scripture_fully_locked"
  ) {
    return { kind: "fatal", reason: errCode };
  }
  return { kind: "conflict", current: (body as { current?: unknown } | null | undefined)?.current };
}

/**
 * Whether a fatal result deletes its op instead of parking it as a failed
 * save (#883 item 4). Only state_mismatch: such an op is the assistant's
 * proposed text, never typing, and a retry would be refused the same way.
 */
export function deletesOnFatal(reason: string): boolean {
  return reason === "state_mismatch";
}

/**
 * Whether the server row in a 409 already holds this patch, so a resend could
 * not write (#883 item 2): false when every patched field already holds the
 * patch's value exactly (the server's no-op test is strict equality, with no
 * newline folding) and the note is not set aside (a set-aside note skips that
 * no-op). Anything else is true: an auto-healed resend writes, and keeps the
 * op's expected_state pin.
 */
export function healKeepsStatePin(patch: Record<string, unknown>, current: unknown): boolean {
  if (!current || typeof current !== "object") return true;
  const row = current as Record<string, unknown>;
  if (row.trashed_at != null) return true;
  const keys = Object.keys(patch);
  if (keys.length === 0) return true;
  return !keys.every((k) => row[k] === patch[k]);
}

/**
 * Whether an auto-healed 409 settles a pinned (assistant) op as saved, using
 * the 409's row as the saved row, instead of resending it (#886 item 1). True
 * when the server already holds the patch (healKeepsStatePin is false): this
 * edit landed and its response was lost. A resend there would have to drop the
 * pin to avoid a refusal, and an unpinned resend would revive a note set aside,
 * or overwrite a revert, made in the gap before it. Ops without a pin (typed
 * edits) keep resending as before.
 */
export function healSettlesAsSaved(
  op: { patch: Record<string, unknown>; expectedState?: string | null },
  current: unknown,
): boolean {
  return op.expectedState !== undefined && !healKeepsStatePin(op.patch, current);
}

/**
 * One op of the row a user resolved with Keep mine (outbox.resolveConflict),
 * re-armed at the server's version. The resolved op also loses its
 * expected_state pin (#883 review A2): the user chose to write over the note
 * as it is now, and the pin would only get the resend refused (state_mismatch)
 * and deleted, so the choice would vanish. The row's other waiting saves keep
 * theirs. Every re-armed op also loses its originPinned mark (#754): it is now
 * at the server's version by the user's choice, so a write of the row landing
 * first threads it again instead of bringing the prompt back. Mutates and
 * returns `o`.
 */
export function rearmOnKeepMine<
  T extends {
    id: string;
    status: string;
    expectedVersion: number;
    conflictCurrent?: unknown;
    expectedState?: string | null;
    originPinned?: boolean;
  },
>(o: T, resolvedId: string, version: number): T {
  o.expectedVersion = version;
  o.status = "pending";
  o.conflictCurrent = undefined;
  delete o.originPinned;
  if (o.id === resolvedId) delete o.expectedState;
  return o;
}
