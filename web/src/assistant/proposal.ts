// Pure helpers for the assistant's proposal cards (issue #858). No React, no
// i18n, no network, so the strip-types test runner loads them.

import { diffWords, tokenizeUnicode, type DiffOp } from "../lib/wordDiff.ts";
import { unescapeNewlines } from "../lib/tsvNewlines.ts";

export interface ProposalActions {
  edits: { id: string; note: string }[];
  approve: string[];
  notNeeded: string[];
}

export type ProposalKind = "e" | "a" | "n";
/** A row's key in the untick set: kind letter, colon, note id. */
export const proposalKey = (kind: ProposalKind, id: string) => `${kind}:${id}`;

/**
 * Clean a server reply's actions before showing them. An edit wins over an
 * approval or a set-aside of the same note: the edit changes the note's
 * version and text, so approving or setting aside the text the user has not
 * seen would be wrong, and an edited note needs its own review first.
 * Duplicate ids keep their first occurrence.
 */
export function normalizeActions(actions: ProposalActions): ProposalActions {
  const seenEdit = new Set<string>();
  const edits = actions.edits.filter((e) => (seenEdit.has(e.id) ? false : (seenEdit.add(e.id), true)));
  const uniq = (ids: string[]) => [...new Set(ids)].filter((id) => !seenEdit.has(id));
  const approve = uniq(actions.approve);
  const notNeeded = uniq(actions.notNeeded);
  // An id in both lists is ambiguous: do neither.
  return { edits, approve: approve.filter((id) => !notNeeded.includes(id)), notNeeded: notNeeded.filter((id) => !approve.includes(id)) };
}

/** The proposal as the user has it ticked: every row unless it is in `unticked`. */
export function selectedActions(actions: ProposalActions, unticked: ReadonlySet<string>): ProposalActions {
  return {
    edits: actions.edits.filter((e) => !unticked.has(proposalKey("e", e.id))),
    approve: actions.approve.filter((id) => !unticked.has(proposalKey("a", id))),
    notNeeded: actions.notNeeded.filter((id) => !unticked.has(proposalKey("n", id))),
  };
}

export function actionCount(a: ProposalActions): number {
  return a.edits.length + a.approve.length + a.notNeeded.length;
}

/**
 * The assistant turn sent back to the server: the reply text plus one plain
 * line saying what it offered, so a follow-up like "now do the rest" makes sense.
 */
/**
 * Earlier replies go back with every message, so each is cut to keep the body
 * under the server's 200 KB limit next to the notes (Arabic is two bytes a
 * character): 10 turns of 2,000 characters plus 120 KB of notes fit.
 */
export const MAX_ECHO_CHARS = 2000;

export function echoContent(reply: string, a: ProposalActions): string {
  reply = reply.slice(0, MAX_ECHO_CHARS);
  const parts: string[] = [];
  if (a.edits.length) parts.push(`${a.edits.length} edit${a.edits.length === 1 ? "" : "s"}`);
  if (a.approve.length) parts.push(`${a.approve.length} approval${a.approve.length === 1 ? "" : "s"}`);
  if (a.notNeeded.length) parts.push(`${a.notNeeded.length} not-needed`);
  return parts.length ? `${reply}\n\n(Proposed ${parts.join(", ")})` : reply;
}

/**
 * A note's word diff, before to proposed. Notes are stored with "\n" escapes;
 * both sides are shown with real line breaks.
 */
export function noteDiff(before: string, proposed: string): DiffOp[] {
  return diffWords(unescapeNewlines(before), unescapeNewlines(proposed), tokenizeUnicode);
}
