// Builds the in-app user guide from help/<lang>/*.md (format: help/README.md).
//
//   node scripts/build-help.mjs           validate, write the index JSON, copy screenshots
//   node scripts/build-help.mjs --check   validate and compare with the committed JSON (CI)
//   node scripts/build-help.mjs --assets  only copy screenshots to web/public/help/ (pre-vite)
//
// The parse/validate/build functions are exported and pure so
// web/src/help/guideMap.test.mjs can use them.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEYS = new Set(["id", "title", "routes", "roles", "keywords", "screenshots"]);
const LIST_KEYS = new Set(["routes", "roles", "keywords", "screenshots"]);
const INDEX_REL = "web/src/help/helpIndex.generated.json";
const KB_REL = "api/src/help/helpKb.generated.ts";

export function parseArticle(text, file) {
  const fail = (msg) => {
    throw new Error(`${file}: ${msg}`);
  };
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0].trim() !== "---") fail("missing front-matter (file must start with ---)");
  const end = lines.indexOf("---", 1);
  if (end < 0) fail("front-matter is not closed with ---");
  const fm = {};
  let listKey = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    let m;
    if ((m = line.match(/^\s+-\s+(.*)$/))) {
      if (!listKey) fail(`line ${i + 1}: list item without a key: ${line}`);
      fm[listKey].push(m[1].trim());
    } else if ((m = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/))) {
      const [, key, val] = m;
      if (!KEYS.has(key)) fail(`unknown front-matter key "${key}"`);
      listKey = null;
      if (val.trim() === "") {
        if (!LIST_KEYS.has(key)) fail(`line ${i + 1}: "${key}" has no value`);
        fm[key] = [];
        listKey = key;
      } else if (val.trim().startsWith("[")) {
        const lm = val.trim().match(/^\[(.*)\]$/);
        if (!lm) fail(`line ${i + 1}: malformed inline list: ${line}`);
        if (!LIST_KEYS.has(key)) fail(`line ${i + 1}: "${key}" must be a plain value`);
        fm[key] = lm[1].trim() === "" ? [] : lm[1].split(",").map((s) => s.trim()).filter(Boolean);
      } else {
        if (LIST_KEYS.has(key)) fail(`line ${i + 1}: "${key}" must be a list`);
        fm[key] = val.trim();
      }
    } else {
      fail(`line ${i + 1}: malformed front-matter line: ${line}`);
    }
  }
  if (!fm.id) fail("missing id");
  if (!fm.title) fail("missing title");
  const screenshots = (fm.screenshots ?? []).map((item) => {
    const parts = item.split(/\s+/);
    let phone = false;
    let top = false;
    let rapid = false;
    // Trailing flags, any order: `phone`, `top`, `rapid` (the notes screen's
    // rapid check layout, switched on before the page loads).
    for (;;) {
      const last = parts[parts.length - 1];
      if (last === "phone") phone = true;
      else if (last === "top") top = true;
      else if (last === "rapid") rapid = true;
      else break;
      parts.pop();
    }
    if (parts.length !== 2) fail(`malformed screenshot line "${item}" (want: <name> <hash> [phone] [top] [rapid])`);
    return { name: parts[0], hash: parts[1], phone, top, rapid };
  });
  const body = lines.slice(end + 1).join("\n").replace(/^\n+/, "");
  const headings = [];
  for (const l of body.split("\n")) {
    const hm = l.match(/^#{2,3}\s+(.*?)\s*#*\s*$/);
    if (hm) headings.push(hm[1]);
  }
  return {
    id: fm.id,
    title: fm.title,
    routes: fm.routes ?? [],
    roles: fm.roles ?? [],
    keywords: fm.keywords ?? [],
    screenshots,
    body,
    headings,
  };
}

export function loadGuide(repoRoot) {
  const helpDir = path.join(repoRoot, "help");
  const guide = {};
  for (const ent of readdirSync(helpDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name === "screenshots") continue;
    const dir = path.join(helpDir, ent.name);
    guide[ent.name] = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => ({ ...parseArticle(readFileSync(path.join(dir, f), "utf8"), `help/${ent.name}/${f}`), file: `help/${ent.name}/${f}` }));
  }
  if (!guide.en) guide.en = [];
  if (!guide.ar) guide.ar = [];
  return guide;
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

export function validateGuide(guide, repoRoot) {
  const errors = [];
  const langs = Object.keys(guide);
  const byLang = {};
  for (const lang of langs) {
    const ids = new Map();
    const routeOwner = new Map();
    for (const a of guide[lang]) {
      if (ids.has(a.id)) errors.push(`${a.file}: duplicate id "${a.id}" (also ${ids.get(a.id).file})`);
      else ids.set(a.id, a);
      for (const r of a.routes) {
        const owner = routeOwner.get(r);
        if (owner && owner !== a.id) errors.push(`${a.file}: route "${r}" is also listed by article "${owner}" in ${lang}`);
        else routeOwner.set(r, a.id);
      }
      if (lang !== "en" && a.screenshots.length) errors.push(`${a.file}: "screenshots:" belongs only in English articles`);
      for (const m of a.body.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const im = m[1].match(/^\.\.\/screenshots\/([^/]+)\/([^/]+\.png)$/);
        if (!im) continue;
        if (im[1] !== lang) errors.push(`${a.file}: image ${m[1]} points at language "${im[1]}", expected "${lang}"`);
        else if (!existsSync(path.join(repoRoot, "help", "screenshots", im[1], im[2]))) errors.push(`${a.file}: image ${m[1]} does not exist (run npm run guide:screenshots)`);
      }
    }
    byLang[lang] = ids;
  }
  for (const a of guide.en ?? []) {
    for (const s of a.screenshots) {
      for (const lang of langs) {
        if (!existsSync(path.join(repoRoot, "help", "screenshots", lang, `${s.name}.png`))) {
          errors.push(`${a.file}: screenshot "${s.name}" has no help/screenshots/${lang}/${s.name}.png (run npm run guide:screenshots)`);
        }
      }
    }
  }
  for (const lang of langs) {
    for (const a of guide[lang]) {
      for (const m of a.body.matchAll(/#help:([a-z0-9][a-z0-9-]*)/g)) {
        if (!byLang[lang].has(m[1])) errors.push(`${a.file}: link to unknown article "#help:${m[1]}"`);
      }
    }
  }
  const allIds = new Set(langs.flatMap((l) => [...byLang[l].keys()]));
  for (const id of [...allIds].sort()) {
    const missing = langs.filter((l) => !byLang[l].has(id));
    if (missing.length) errors.push(`article "${id}" is missing in: ${missing.join(", ")}`);
    const present = langs.filter((l) => byLang[l].has(id));
    const first = byLang[present[0]].get(id);
    for (const l of present.slice(1)) {
      const o = byLang[l].get(id);
      if (!sameSet(first.routes, o.routes)) errors.push(`article "${id}": routes differ between ${present[0]} and ${l}`);
      if (!sameSet(first.roles, o.roles)) errors.push(`article "${id}": roles differ between ${present[0]} and ${l}`);
    }
  }
  return errors;
}

export function buildIndex(guide) {
  const langs = {};
  for (const lang of Object.keys(guide).sort()) {
    langs[lang] = {
      articles: guide[lang].map((a) => ({
        id: a.id,
        title: a.title,
        routes: a.routes,
        roles: a.roles,
        keywords: a.keywords,
        headings: a.headings,
        body: a.body.replace(/\.\.\/screenshots\/([^/\s)]+)\/([^/\s)]+\.png)/g, "/help/$1/$2"),
      })),
    };
  }
  return { version: 1, langs };
}

// The whole guide per language as plain text for the server-side help
// assistant: one <article> block per article, image lines removed.
export function buildKb(guide) {
  const kb = {};
  for (const lang of Object.keys(guide).sort()) {
    kb[lang] = guide[lang]
      .map((a) => {
        const body = a.body
          .split("\n")
          .filter((l) => !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(l))
          .join("\n")
          .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        const attr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        return `<article id="${attr(a.id)}" title="${attr(a.title)}">\n${body}\n</article>`;
      })
      .join("\n\n");
  }
  return kb;
}

export function serializeKb(kb) {
  return (
    "// GENERATED by scripts/build-help.mjs from help/<lang>/*.md. Do not edit.\n" +
    "// Regenerate with: node scripts/build-help.mjs\n" +
    `export const HELP_KB: Record<string, string> = ${JSON.stringify(kb, null, 2)};\n`
  );
}

function serialize(index) {
  return JSON.stringify(index, null, 2) + "\n";
}

function copyAssets(repoRoot) {
  const out = path.join(repoRoot, "web", "public", "help");
  rmSync(out, { recursive: true, force: true });
  const src = path.join(repoRoot, "help", "screenshots");
  if (!existsSync(src)) return;
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dest = path.join(out, ent.name);
    mkdirSync(dest, { recursive: true });
    for (const f of readdirSync(path.join(src, ent.name))) {
      if (f.endsWith(".png")) cpSync(path.join(src, ent.name, f), path.join(dest, f));
    }
  }
}

export function main(argv, repoRoot) {
  if (argv.includes("--assets")) {
    copyAssets(repoRoot);
    return 0;
  }
  const guide = loadGuide(repoRoot);
  const errors = validateGuide(guide, repoRoot);
  if (errors.length) {
    console.error(`Help guide has ${errors.length} problem(s):\n` + errors.map((e) => `  - ${e}`).join("\n"));
    return 1;
  }
  const json = serialize(buildIndex(guide));
  const target = path.join(repoRoot, INDEX_REL);
  const kbJson = serializeKb(buildKb(guide));
  const kbTarget = path.join(repoRoot, KB_REL);
  if (argv.includes("--check")) {
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (current !== json) {
      console.error("help index is stale: run node scripts/build-help.mjs");
      return 1;
    }
    const kbCurrent = existsSync(kbTarget) ? readFileSync(kbTarget, "utf8") : null;
    if (kbCurrent !== kbJson) {
      console.error("help knowledge base is stale: run node scripts/build-help.mjs");
      return 1;
    }
    return 0;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, json);
  mkdirSync(path.dirname(kbTarget), { recursive: true });
  writeFileSync(kbTarget, kbJson);
  copyAssets(repoRoot);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = process.env.HELP_REPO_ROOT
    ? path.resolve(process.env.HELP_REPO_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  process.exit(main(process.argv.slice(2), repoRoot));
}
