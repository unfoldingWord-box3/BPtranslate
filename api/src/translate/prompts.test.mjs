// prompts/: the checked-in SKILL.md bodies and the API-mode system prompt.
// The bot's buildTranslatePrompt "strips frontmatter and appends the API mode
// override" case (translate-llm.test.js) is covered here for the system half;
// the user-message half lands with llm.ts (step 2). When a bp-assistant-skills
// checkout is present, the constants are compared byte-for-byte against it
// (design risk 5: prompt drift); otherwise that case is skipped, not failed.
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/prompts.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  API_MODE_OVERRIDE, SECOND_PASS_REVIEW, BEGIN_OUTPUT, END_OUTPUT, SKILL_BODIES, skillBody, systemPromptFor, stripFrontmatter,
} from "./prompts/index.ts";
import { RESOURCE_TYPES } from "./resourceTypes.ts";

const SKILLS_DIR = [process.env.BP_SKILLS_DIR, "C:/GH/bp-bot/bp-assistant-skills"].filter(Boolean).find((d) => existsSync(d));
// The committed blob at the skills repo's origin/main is the source of truth
// (what the bot deploys). The working tree is NOT: the local checkout is a live
// repo that sibling sessions switch between branches, and comparing against it
// once captured an unmerged review branch's wording.
const SKILLS_REF = process.env.BP_SKILLS_REF || "origin/main";

function committedSkill(skill) {
  return execFileSync("git", ["-C", SKILLS_DIR, "show", `${SKILLS_REF}:.claude/skills/${skill}/SKILL.md`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test("every registry skill has a non-empty body with its iron rules", () => {
  for (const rt of Object.values(RESOURCE_TYPES)) {
    const body = skillBody(rt.skill);
    assert.ok(body.length > 1000, `${rt.skill} body present`);
    assert.ok(!body.startsWith("---"), `${rt.skill} frontmatter stripped`);
    assert.ok(!/^name: translate-/m.test(body), `${rt.skill} frontmatter fields gone`);
    assert.match(body, /## The iron rules \(deterministic checks WILL reject violations\)/);
    assert.equal(body, body.trim(), "body is trimmed");
  }
  assert.match(SKILL_BODIES["translate-tn"], /^# translate-tn — gateway-language translation of tN rows/);
  assert.match(SKILL_BODIES["translate-tq"], /^# translate-tq — /);
  assert.match(SKILL_BODIES["translate-article"], /^# translate-article — /);
  // The tN skill quotes the header with real tabs; JSON round-trip must keep them.
  assert.match(SKILL_BODIES["translate-tn"], /Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote/);
});

test("no prompt constant contains a carriage return (bot reads LF blobs; a CRLF checkout must not leak in)", () => {
  for (const [skill, body] of Object.entries(SKILL_BODIES)) {
    assert.equal((body.match(/\r/g) || []).length, 0, `${skill} body has \\r — regenerate with scripts/sync-translate-prompts.mjs`);
  }
  assert.ok(!API_MODE_OVERRIDE.includes("\r"));
  assert.ok(!systemPromptFor("translate-tq").includes("\r"));
});

test("skillBody rejects unknown / missing skill names", () => {
  assert.throws(() => skillBody(""), /no skill name/);
  assert.throws(() => skillBody("translate-zulip"), /unknown skill "translate-zulip"/);
  assert.throws(() => skillBody("constructor"), /unknown skill/);
});

test("systemPromptFor = body + second-pass review + API mode override + newline (bot translate-llm.js:156 + editor section)", () => {
  const system = systemPromptFor("translate-tn");
  assert.equal(system, `${SKILL_BODIES["translate-tn"]}\n\n${SECOND_PASS_REVIEW}\n\n${API_MODE_OVERRIDE}\n`);
  assert.ok(system.includes("## API mode override (supersedes the Input/Output mechanics above)"));
  assert.ok(system.includes(`\n${BEGIN_OUTPUT}\n(the complete output file content)\n${END_OUTPUT}\n`));
  assert.equal(BEGIN_OUTPUT, "-----BEGIN OUTPUT-----");
  assert.equal(END_OUTPUT, "-----END OUTPUT-----");
  assert.ok(API_MODE_OVERRIDE.endsWith("corrected file between the same markers."));
});

test("stripFrontmatter matches the bot algorithm", () => {
  assert.equal(stripFrontmatter("---\nname: x\n---\n\n# Body\n"), "# Body");
  assert.equal(stripFrontmatter("\uFEFF---\r\nname: x\r\n---\r\n# Body"), "# Body");
  assert.equal(stripFrontmatter("# No frontmatter\n"), "# No frontmatter");
  assert.equal(stripFrontmatter("---\nunterminated"), "---\nunterminated");
  assert.equal(stripFrontmatter("---\nname: x\n---"), "");
});

test("checked-in bodies match the committed skills blobs at origin/main byte-for-byte (skipped without a checkout)", (t) => {
  if (!SKILLS_DIR) {
    t.skip("no bp-assistant-skills checkout (set BP_SKILLS_DIR)");
    return;
  }
  try {
    execFileSync("git", ["-C", SKILLS_DIR, "rev-parse", SKILLS_REF], { stdio: "ignore" });
  } catch {
    t.skip(`${SKILLS_REF} not resolvable in ${SKILLS_DIR} (not a git checkout, or never fetched)`);
    return;
  }
  for (const [skill, body] of Object.entries(SKILL_BODIES)) {
    // LF-normalize like the generator so a CRLF-converting git config cannot matter.
    const expected = stripFrontmatter(committedSkill(skill).replace(/\r\n/g, "\n"));
    assert.equal(body, expected, `${skill} body drifted from ${SKILLS_REF} — run node scripts/sync-translate-prompts.mjs (git fetch the skills repo first)`);
    // The generator stamps sha256(body) into the module header; keep it honest.
    const modFile = fileURLToPath(new URL(`./prompts/${{ "translate-tn": "translateTn", "translate-tq": "translateTq", "translate-article": "translateArticle" }[skill]}.ts`, import.meta.url));
    const stamped = /sha256\(body\) = ([0-9a-f]{64})/.exec(readFileSync(modFile, "utf8"))?.[1];
    assert.equal(stamped, createHash("sha256").update(body, "utf8").digest("hex"), `${skill} header sha256 matches body`);
  }
});

test("every translate skill gets the second-pass review, after the skill rules and before the API mode override", () => {
  for (const skill of Object.keys(SKILL_BODIES)) {
    const system = systemPromptFor(skill);
    const review = system.indexOf("## Second pass: refine the wording before you emit");
    assert.ok(review > system.indexOf(SKILL_BODIES[skill].slice(-40)), `${skill}: review follows the skill body`);
    assert.ok(review < system.indexOf("## API mode override"), `${skill}: review precedes the API mode override`);
  }
  assert.match(SECOND_PASS_REVIEW, /Do not change the meaning/);
  assert.match(SECOND_PASS_REVIEW, /clarification only when the meaning genuinely requires it/);
  assert.match(SECOND_PASS_REVIEW, /never emit the\s+first draft/);
  assert.ok(!SECOND_PASS_REVIEW.includes("\r"));
});
