// Guard for the classic ↔ new-desk admin parity map (adminSurfaceMap.ts).
//
// Two directions of enforcement:
//  1. Coverage — every classic Preferences section and every AdminDesk nav
//     destination must be registered in the map, so adding an admin surface to
//     either UI without deciding what happens on the other side fails loudly.
//  2. Truth — every map entry must point at code that still exists, so the map
//     can't rot when features move or retire.
//
// If a parser assertion here fails, the source file it reads changed shape:
// update the regex AND re-check the map still reflects reality.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_SURFACES } from "../adminSurfaceMap.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(webRoot, rel), "utf8");
// Strip line comments before parsing so a future `// note; with a semicolon`
// inside a type union can't truncate the parse and silently shrink coverage.
const readStripped = (rel) => read(rel).replace(/\/\/[^\n]*/g, "");

const REGISTER_HINT =
  "Register it in web/src/adminSurfaceMap.ts: point at its home in BOTH UIs, or set the missing side to null " +
  "(a classic-only feature with no desk home needs a gapIssue — file the port issue first). " +
  "See the map header for the rules.";

function parseClassicSections() {
  const src = readStripped("src/components/PreferencesWorkspace.tsx");
  const m = src.match(/export type Section =([\s\S]*?);/);
  assert.ok(
    m,
    "Parser rot: `export type Section =` not found in PreferencesWorkspace.tsx — update adminSurfaceMap.test.mjs to match the new shape",
  );
  const ids = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.ok(ids.length >= 5, `Parser rot: Section union parse found only ${ids.length} ids`);
  return ids;
}

// Every AdminDesk rail entry (both the top-4 admin sections and the four
// former pill-bar "More tools" pages, unified onto AdminSection in #186) is now
// keyed by one AdminSection member — the union is the single source of nav
// identities. Each routes to its own hash (#/admin/progress, #/admin/ai, …),
// but that's a routing detail, not a separate coverage identity.
function parseDeskPages() {
  const src = readStripped("src/components/flows/AdminDesk.tsx");
  const um = src.match(/export type AdminSection =([^;]*);/);
  assert.ok(
    um,
    "Parser rot: `export type AdminSection =` not found in AdminDesk.tsx — update adminSurfaceMap.test.mjs to match the new shape",
  );
  const sections = [...um[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.ok(sections.length >= 1, "Parser rot: AdminSection union parse found no keys");
  return { sections };
}

test("every classic Preferences section is registered in the admin surface map", () => {
  const registered = new Set(ADMIN_SURFACES.map((e) => e.classic?.section).filter(Boolean));
  for (const id of parseClassicSections()) {
    assert.ok(
      registered.has(id),
      `Classic Preferences section "${id}" has no adminSurfaceMap entry. ${REGISTER_HINT}`,
    );
  }
});

test("every AdminDesk nav destination is registered in the admin surface map", () => {
  const { sections } = parseDeskPages();
  const registered = new Set(ADMIN_SURFACES.map((e) => e.desk?.page).filter(Boolean));
  for (const page of sections) {
    assert.ok(
      registered.has(page),
      `AdminDesk nav destination "${page}" has no adminSurfaceMap entry. ${REGISTER_HINT}`,
    );
  }
});

test("map entries point at real code and declare their gaps", () => {
  const classicIds = new Set(parseClassicSections());
  const { sections } = parseDeskPages();
  const deskPages = new Set(sections);

  const seen = new Set();
  for (const e of ADMIN_SURFACES) {
    assert.ok(!seen.has(e.id), `Duplicate adminSurfaceMap id "${e.id}"`);
    seen.add(e.id);
    assert.ok(e.classic || e.desk, `Entry "${e.id}" has neither a classic nor a desk surface — delete it or fill one in`);

    if (e.classic) {
      assert.ok(
        classicIds.has(e.classic.section),
        `Entry "${e.id}" claims classic section "${e.classic.section}", which is not in PreferencesWorkspace's Section union — stale map entry? Update or remove it.`,
      );
      const src = read(e.classic.file);
      assert.ok(
        src.includes(`"${e.classic.section}"`),
        `Entry "${e.id}": section id "${e.classic.section}" no longer appears in ${e.classic.file} — the feature moved or retired; update the map.`,
      );
    }

    if (e.desk) {
      assert.ok(
        typeof e.desk.anchor === "string" && e.desk.anchor.length > 0,
        `Entry "${e.id}" has an empty desk anchor — includes("") passes vacuously; give it a real mount/definition string.`,
      );
      assert.ok(
        deskPages.has(e.desk.page),
        `Entry "${e.id}" claims desk page "${e.desk.page}", which is not in AdminDesk's nav (sections: ${[...sections]}) — stale map entry? Update or remove it.`,
      );
      const src = readStripped(e.desk.file);
      assert.ok(
        src.includes(e.desk.anchor),
        `Entry "${e.id}": anchor "${e.desk.anchor}" no longer appears in ${e.desk.file} — the feature moved or retired; update the map.`,
      );
    }

    if (e.classic && !e.desk) {
      assert.ok(
        typeof e.gapIssue === "number",
        `Entry "${e.id}" exists in classic but has no desk home and no gapIssue — file a GitHub issue for the port and record its number here.`,
      );
    }
  }
});
