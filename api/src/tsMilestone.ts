// True iff `node` is a `\ts\*` translator-section chunk milestone, in ANY of the
// shapes usfm-js has produced for it. Matching only the legacy shape is a silent
// no-op on real data: usfm-js 3.5.0 parks the whole marker in the tag
// (`{tag:"ts\\*"}`) with no `type` and no `content`.
// Shapes, newest first:
//   usfm-js 3.5.0, well-formed  → {tag:"ts\\*"}
//   editor-written, malformed   → {tag:"ts*"}     (repaired on export)
//   legacy usfm-js              → {tag:"ts", content:"\\*"|"*"}
// Mirrors isTsMilestone in web/src/lib/usfm.ts — keep the two in sync (the
// workspaces share no code).
export function isTsMilestone(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  const tag = o["tag"];
  if (tag === "ts\\*" || tag === "ts*") return true;
  return tag === "ts" && (o["content"] === "\\*" || o["content"] === "*");
}
