// Which warning the AI run dialog shows about Bible text the AI can't see yet
// (#679). Pure, so the stale-result rules are unit-tested
// (unpublishedScriptureWarning.test.mjs).
//
// The dialog checks GET /api/pipelines/unpublished-scripture/:book each time
// it opens. A result is tagged with the opening (`openId`) and book it was
// asked for, and only a result for THIS opening and book shows: a reopen, a
// failed request or a book change never shows an earlier answer.

/** Per lane, from the server (api/src/unpublishedScripture.ts). */
export type ScriptureStatus = "current" | "pending" | "unpublishable";

export type UnpublishedCheck = {
  openId: number;
  book: string;
  ult: ScriptureStatus;
  ust: ScriptureStatus;
};

/**
 * "unpublishable": a lane has edits and its export is off, so no publish will
 * bring them to Door43. "pending": the nightly publish will. null: no warning.
 */
export function unpublishedWarning(
  check: UnpublishedCheck | null,
  openId: number,
  book: string,
): "pending" | "unpublishable" | null {
  if (!check || check.openId !== openId || check.book !== book) return null;
  const lanes = [check.ult, check.ust];
  if (lanes.includes("unpublishable")) return "unpublishable";
  if (lanes.includes("pending")) return "pending";
  return null;
}
