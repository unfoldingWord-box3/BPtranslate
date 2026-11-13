// prompts/index.ts — the system-prompt half of the translate LLM call.
//
// The bot reads each skill's SKILL.md off disk at call time
// (translate-llm.js readSkillBody) and appends API_MODE_OVERRIDE. In the
// Worker there is no disk, so the three skill bodies are checked in as
// generated string constants (translateTn.ts / translateTq.ts /
// translateArticle.ts — regenerate with `node scripts/sync-translate-prompts.mjs`
// against a bp-assistant-skills checkout; see that script) and this module
// assembles the same system prompt (issue #445, design §A "Prompt fidelity").
//
// API_MODE_OVERRIDE, BEGIN_OUTPUT and END_OUTPUT are verbatim from
// bp-assistant src/lib/translate-llm.js:22-23, 93-115.

import type { SkillName } from "../resourceTypes.ts";
import { TRANSLATE_TN_SKILL_BODY } from "./translateTn.ts";
import { TRANSLATE_TQ_SKILL_BODY } from "./translateTq.ts";
import { TRANSLATE_ARTICLE_SKILL_BODY } from "./translateArticle.ts";

export const BEGIN_OUTPUT = "-----BEGIN OUTPUT-----";
export const END_OUTPUT = "-----END OUTPUT-----";

// Appended to every skill body. The skill's own Input/Output sections describe
// Read/Write mechanics that do not exist here, so this section must override
// them explicitly rather than merely add to them.
export const API_MODE_OVERRIDE = `## API mode override (supersedes the Input/Output mechanics above)

You are running as a single API completion. There are no tools: no Read, no
Write, no filesystem, no shell. Every instruction above that tells you to read
or write a file is superseded by this section.

- The task JSON, the context pack, and the source content are inlined in the
  user message. Those are the complete inputs; there is nothing else to read.
- Do not write a file. Emit the COMPLETE content of the output file in your
  reply, between these two exact marker lines:

${BEGIN_OUTPUT}
(the complete output file content)
${END_OUTPUT}

- Emit nothing after the ${END_OUTPUT} line — no commentary, no summary, no
  "done:" line. Anything before the ${BEGIN_OUTPUT} line is discarded.
- The text between the markers is written to the output file verbatim, so it
  must be the whole file: the full TSV header and every row, or the full
  article body. Never abbreviate and never elide with "...".
- In repair mode the user message includes your previous output and the list of
  validation violations. Apply exactly those fixes and re-emit the complete
  corrected file between the same markers.`;

// Appended to every skill body, ahead of API_MODE_OVERRIDE. Editor-owned (not
// from bp-assistant-skills): requested by the Arabic team and applied to every
// target language. It sits after the skill's own rules so it reads as a
// refinement pass inside them, never as licence to break them.
export const SECOND_PASS_REVIEW = `## Second pass: refine the wording before you emit

After drafting each translated sentence, check it a second time before you emit
it. In this pass, make the wording in the target language as natural, clear and
well-structured as you can, while staying faithful to the source text:

- Do not change the meaning. Do not add, drop, soften or strengthen anything the
  source says.
- Fix wording that reads as translated: stilted word order, calques of English
  phrasing, awkward or run-on sentence structure, unclear references.
- Add a clarification only when the meaning genuinely requires it for a reader
  of the target language. Do not add explanation for its own sake.
- This pass works inside every rule above. It never changes protected columns or structure,
  \`rc://\` links, \`\\n\` conventions, the count of \`[bracketed]\` alternate
  translations, bold words that must match the target Bible text, or preferred
  terminology.
- Do this review silently. Emit only the final, refined text; never emit the
  first draft, a list of changes, or commentary.
- In repair mode, skip this pass for rows that already passed validation: fix
  only the listed violations, as the repair instructions say.`;

export const SKILL_BODIES: Record<SkillName, string> = {
  "translate-tn": TRANSLATE_TN_SKILL_BODY,
  "translate-tq": TRANSLATE_TQ_SKILL_BODY,
  "translate-article": TRANSLATE_ARTICLE_SKILL_BODY,
};

/** The SKILL.md body (frontmatter stripped, trimmed) for a translate skill. */
export function skillBody(skill: string): string {
  if (!skill) throw new Error("translate prompts: no skill name supplied");
  if (!Object.prototype.hasOwnProperty.call(SKILL_BODIES, skill)) {
    throw new Error(`translate prompts: unknown skill "${skill}" (expected one of: ${Object.keys(SKILL_BODIES).join(", ")})`);
  }
  return SKILL_BODIES[skill as SkillName];
}

/**
 * The system prompt for one batch/article call: what the bot's
 * buildTranslatePrompt puts in `system` (translate-llm.js:156), plus the
 * editor-owned SECOND_PASS_REVIEW section between the skill body and the API
 * mode override.
 */
export function systemPromptFor(skill: string): string {
  return `${skillBody(skill)}\n\n${SECOND_PASS_REVIEW}\n\n${API_MODE_OVERRIDE}\n`;
}

/**
 * Strip the YAML frontmatter block delimited by the first two --- lines
 * (translate-llm.js:128-135). Exported so the checksum test can re-derive a
 * body from a skills checkout with the exact algorithm the generator used.
 */
export function stripFrontmatter(text: string): string {
  const normalized = text.replace(/^﻿/, "");
  if (!/^---\r?\n/.test(normalized)) return normalized.trim();
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return normalized.trim();
  const after = normalized.indexOf("\n", end + 1);
  return (after === -1 ? "" : normalized.slice(after + 1)).trim();
}
