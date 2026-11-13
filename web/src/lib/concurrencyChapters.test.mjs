// Guard for tests/concurrency/chapters.ts, the table of which Playwright
// concurrency spec uses which seeded ZEC chapter (#891).
//
// It lives here, not next to the specs, because Playwright collects every
// *.test.* file in tests/concurrency, and `npm --workspace web run test` is the
// node test command CI already runs.
//
// Fails when:
//   1. two table entries name the same chapter (the message names both entries'
//      specs);
//   2. a .ts file in tests/concurrency (other than chapters.ts) writes a ZEC
//      chapter as a number instead of `ZEC_CHAPTERS.<key>.chapter`;
//   3. a file uses an entry whose `specs` list does not name it, or uses the
//      table in any form other than `ZEC_CHAPTERS.<key>.chapter`;
//   4. a `specs` list names a file that does not exist;
//   5. a *.spec.ts file that mentions ZEC is in no entry's `specs` (so a new
//      spec has to pick its chapter in the table, even if it hides the number
//      behind its own constant).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZEC_CHAPTERS } from "../../../tests/concurrency/chapters.ts";

const specDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/concurrency");
const TABLE_FILE = "chapters.ts";

/** Problems with the table itself: shared chapter numbers, missing spec files. */
function tableProblems(table, existingFiles) {
  const problems = [];
  const byChapter = new Map();
  for (const [key, entry] of Object.entries(table)) {
    const prior = byChapter.get(entry.chapter);
    if (prior) {
      problems.push(
        `ZEC ${entry.chapter} is claimed twice in tests/concurrency/${TABLE_FILE}: ` +
          `entry "${prior.key}" (${prior.entry.specs.join(", ")}) and ` +
          `entry "${key}" (${entry.specs.join(", ")}). ` +
          `Give the new spec an unused chapter, or add it to the existing entry's specs and say why it is safe.`,
      );
    } else {
      byChapter.set(entry.chapter, { key, entry });
    }
    for (const spec of entry.specs) {
      if (!existingFiles.has(spec)) {
        problems.push(`Entry "${key}" (ZEC ${entry.chapter}) lists ${spec}, which is not a file in tests/concurrency.`);
      }
    }
  }
  return problems;
}

// ZEC chapter numbers written as literals. Each pattern is one shape the specs
// used before #891; comments are stripped before matching.
const LITERAL_PATTERNS = [
  /["'`]ZEC["'`]\s*,\s*\d/, //            fetchChapter(ctx, token, "ZEC", 6)
  /ZEC[/ ]\d/, //                          "#/ZEC/6/3", "/api/chapters/ZEC/6", "ZEC 6:1", "ZEC 6"
  /\$\{[\w.]*(?:BOOK|book)\}[/ ]\d/, //    `/#/${RTL_FIXTURE.book}/1`
  /\bchapter\s*[:=]\s*\d/i, //             chapter: 6, CHAPTER = 3, SQL "chapter = 13"
  /\bref_raw\s*:\s*["'`]\d/, //            ref_raw: "6:1"
  /\$\{\d+\}/, //                          ref_raw: `${6}:${verse}`
];

/**
 * Source with comments removed, keeping line breaks so line numbers hold. A
 * comment must start after whitespace or punctuation, so the `//` and `/**` in
 * a string such as "https://git.door43.org/**" are left alone.
 */
function stripComments(src) {
  return src
    .replace(/(^|[\s;,(){}])\/\*[\s\S]*?\*\//g, (m, pre) => pre + m.slice(pre.length).replace(/[^\n]/g, " "))
    .replace(/(^|[\s;,(){}])\/\/[^\n]*/g, "$1");
}

/** Problems in one tests/concurrency source file. */
function fileProblems(table, file, src) {
  const problems = [];
  const lines = stripComments(src).split("\n");
  lines.forEach((line, i) => {
    for (const re of LITERAL_PATTERNS) {
      if (re.test(line)) {
        problems.push(
          `${file}:${i + 1} writes a ZEC chapter as a number (${line.trim()}). ` +
            `Use ZEC_CHAPTERS.<key>.chapter from ${TABLE_FILE}, adding an entry if the spec needs a new chapter.`,
        );
        break;
      }
    }
    for (const m of line.matchAll(/\bZEC_CHAPTERS\b(\.(\w+)\.chapter\b)?/g)) {
      const key = m[2];
      if (!key) {
        // The import is the only other allowed mention, on one line or wrapped.
        if (/^\s*import\b/.test(line) || /^\s*ZEC_CHAPTERS,?\s*$/.test(line)) continue;
        problems.push(`${file}:${i + 1} uses ZEC_CHAPTERS other than as ZEC_CHAPTERS.<key>.chapter (${line.trim()}).`);
        continue;
      }
      const entry = table[key];
      if (!entry) {
        problems.push(`${file}:${i + 1} uses ZEC_CHAPTERS.${key}, which is not an entry in ${TABLE_FILE}.`);
      } else if (!entry.specs.includes(file)) {
        problems.push(
          `${file}:${i + 1} uses ZEC ${entry.chapter} (entry "${key}") but is not in that entry's specs. ` +
            `ZEC ${entry.chapter} belongs to ${entry.specs.join(", ")}: ${entry.why} ` +
            `Pick an unused chapter, or add ${file} to "${key}".specs and say why sharing is safe.`,
        );
      }
    }
  });
  return problems;
}

/** A *.spec.ts that mentions ZEC but is in no entry's `specs`. */
function unregisteredSpec(table, file, src) {
  if (!file.endsWith(".spec.ts") || !/\bZEC\b/.test(src)) return [];
  if (Object.values(table).some((e) => e.specs.includes(file))) return [];
  return [
    `${file} uses the ZEC fixture but no entry in ${TABLE_FILE} lists it. ` +
      `Add it to the entry for the chapter it uses, or add an entry on an unused chapter.`,
  ];
}

function concurrencyFiles() {
  return readdirSync(specDir).filter((f) => f.endsWith(".ts"));
}

test("no two entries in tests/concurrency/chapters.ts claim the same ZEC chapter, and every listed spec exists", () => {
  const problems = tableProblems(ZEC_CHAPTERS, new Set(concurrencyFiles()));
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("tests/concurrency files take their ZEC chapter from chapters.ts, and only from entries that list them", () => {
  const problems = [];
  for (const file of concurrencyFiles()) {
    if (file === TABLE_FILE) continue;
    const src = readFileSync(path.join(specDir, file), "utf8");
    problems.push(...unregisteredSpec(ZEC_CHAPTERS, file, src), ...fileProblems(ZEC_CHAPTERS, file, src));
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("the checks catch what they are for", () => {
  const table = {
    a: { chapter: 13, specs: ["a.spec.ts"], why: "AI drafts." },
    b: { chapter: 13, specs: ["b.spec.ts"], why: "Edits notes." },
  };
  const dup = tableProblems(table, new Set(["a.spec.ts", "b.spec.ts"]));
  assert.equal(dup.length, 1);
  assert.match(dup[0], /ZEC 13 is claimed twice.*a\.spec\.ts.*b\.spec\.ts/);
  assert.match(tableProblems(table, new Set(["a.spec.ts"])).join("\n"), /lists b\.spec\.ts, which is not a file/);

  const one = { a: table.a };
  for (const literal of [
    `await fetchChapter(p, t, "ZEC", 13);`,
    `await page.goto("/#/notes/ZEC/13/2");`,
    `expect(x, "a note on ZEC 13:1").toBeTruthy();`,
    "await page.goto(`/#/${BOOK}/13`);",
    `const CHAPTER = 13;`,
    `data: { book: "ZEC", chapter: 13, verse: 1, ref_raw: "13:1" },`,
    "`UPDATE tn_rows SET x = 1 WHERE book = 'ZEC' AND chapter = 13;`",
    "ref_raw: `${13}:${verse}`,",
    // A number right after a book constant: the helpers take (…, book, chapter, …).
    `await fetchChapter(ctx, token, BOOK, 13);`,
    `await gotoVerse(page, BOOK, 13, 1);`,
    `await waitForServerNote(ctx, token, BOOK, 13, id, (n) => n === x);`,
    `await fetchChapter(probe, auth.token, RTL_FIXTURE.book, 13);`,
    `await gotoVerse(page, book, 13, 1);`,
  ]) {
    assert.match(fileProblems(one, "x.spec.ts", literal).join("\n"), /writes a ZEC chapter as a number/, literal);
  }
  assert.deepEqual(fileProblems(one, "x.spec.ts", `// ZEC 13 is in a comment\nconst c = 1;`), []);
  assert.deepEqual(fileProblems(one, "a.spec.ts", `const CHAPTER = ZEC_CHAPTERS.a.chapter;`), []);
  assert.match(
    fileProblems(one, "c.spec.ts", `const CHAPTER = ZEC_CHAPTERS.a.chapter;`).join("\n"),
    /c\.spec\.ts:1 uses ZEC 13 \(entry "a"\) but is not in that entry's specs\. ZEC 13 belongs to a\.spec\.ts: AI drafts\./,
  );
  assert.match(fileProblems(one, "a.spec.ts", `const all = ZEC_CHAPTERS;`).join("\n"), /other than as/);
  assert.deepEqual(fileProblems(one, "a.spec.ts", `import {\n  ZEC_CHAPTERS,\n} from "./chapters";`), []);
  assert.deepEqual(fileProblems(one, "a.spec.ts", `await gotoVerse(page, BOOK, CHAPTER, 1);`), []);
  // An alias hides every later use from the entry check.
  assert.match(
    fileProblems(one, "a.spec.ts", `import { ZEC_CHAPTERS as Z } from "./chapters";`).join("\n"),
    /imports ZEC_CHAPTERS under another name/,
  );
  assert.match(
    fileProblems(one, "a.spec.ts", `import {\n  ZEC_CHAPTERS as Z,\n} from "./chapters";`).join("\n"),
    /imports ZEC_CHAPTERS under another name/,
  );
  // A bare `ZEC_CHAPTERS,` line is allowed only inside an import.
  assert.match(fileProblems(one, "a.spec.ts", `const all = [\n  ZEC_CHAPTERS,\n];`).join("\n"), /other than as/);

  // A new spec that hides its chapter behind its own constant still has to be listed.
  const hidden = `const BOOK = "ZEC";\nconst CH = 7 * 2;\nawait fetchChapter(p, t, BOOK, CH);`;
  assert.match(unregisteredSpec(one, "new.spec.ts", hidden).join("\n"), /new\.spec\.ts uses the ZEC fixture but no entry/);
  assert.deepEqual(unregisteredSpec(one, "a.spec.ts", hidden), []);
  assert.deepEqual(unregisteredSpec(one, "helpers.ts", hidden), []);
});
