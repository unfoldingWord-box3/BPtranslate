// Server-shipped built-in layout defaults for the flexible-layouts feature.
// The GET /api/project-config response carries `layouts: builtinLayoutsFor(cfg)`
// so a project's default layouts ship from the server; the client keeps a
// byte-identical bundled fallback (web/src/lib/builtinLayouts.ts) for offline
// resilience and validates whatever the server sends against its panel registry.
//
// The three specs below MUST stay structurally identical (ids, names, region
// ids, panel ids, sizes, orientations) to the client's getBuiltinLayouts so a
// project rendering server layouts looks the same as one on the fallback. The
// client's validateLayoutSpec / validateLayoutAgainstRegistry catch any drift at
// runtime (a bad spec is dropped, not fatal).

// --- mirror of web/src/lib/layoutSpec.ts — keep in sync ---
// (api cannot import from web/src; these are the type definitions only, copied
//  verbatim. The validator/normalizer live client-side and are not needed here.)

export type Axis = "horizontal" | "vertical";
export type ScriptureMode = "stacked" | "columns" | "book";
export type PanelType =
  | "scripture"
  | "original"
  | "notes"
  | "words"
  | "questions"
  | "taArticle"
  | "twArticle"
  | "articleList"
  | "alignment"
  | "search";

export interface PanelConfig {
  mode?: ScriptureMode; // scripture
  versions?: string[] | "inherit"; // scripture
  pairAxis?: Axis; // notes / taArticle / twArticle source-target axis
  resource?: "uhb" | "ugnt"; // original
  resourceType?: "tw" | "ta"; // articleList / article panels
  showOccurrences?: boolean; // article panels
}

export interface PanelInstance {
  id: string;
  type: PanelType;
  minimized?: boolean; // runtime default; live state lives in the store override
  size?: number; // optional within-region fraction
  config?: PanelConfig;
}

export interface PanelRegion {
  kind: "region";
  id: string;
  size?: number;
  display?: "stacked" | "tabs"; // default "stacked"
  hidden?: boolean; // region on/off (default false)
  panels: PanelInstance[]; // may be empty (an emptied region)
}

export interface SplitNode {
  kind: "split";
  orientation: Axis;
  size?: number;
  children: LayoutNode[]; // length >= 2
}

export type LayoutNode = SplitNode | PanelRegion;

export interface LayoutSpec {
  v: 2;
  id: string; // "builtin:*" | "user:<uuid>"
  name: string;
  builtin: boolean;
  requires?: "translation"; // hidden unless the project is a translation project
  rail: { visible: boolean };
  root: LayoutNode;
}
// --- end mirror ---

import type { ProjectConfig } from "./projectConfig.ts";

export const CLASSIC_LAYOUT_ID = "builtin:classic";

// Server equivalent of the client's isTranslationProject
// (web/src/hooks/useProjectConfig.ts). Must mirror it exactly: the server's
// layout list is what the client actually uses when present, so any divergence
// here silently overrides the client's own answer.
//
// `config.mode` (the admin's Editor/Translator toggle) is the source of truth.
// It used to be derived from translationSource, and this function still gated
// on translationSource alone — which meant flipping the toggle to Translator on
// a project without a configured source language never revealed the
// Translate-Notes layout, and flipping to Editor on one that had a source
// language failed to hide it. translationSource remains the fallback only for
// legacy configs materialized before `mode` existed.
export function isTranslationConfig(config: ProjectConfig): boolean {
  if (config.mode === "authoring" || config.mode === "translation") {
    return config.mode === "translation";
  }
  return config.translationSource != null;
}

// Derive the scripture versions the Translate-Notes layout should pin. Mirrors
// the client's translateNotesVersions: the project's configured GL bibles, with
// a sensible default when none are configured.
function translateNotesVersions(config: ProjectConfig): string[] {
  const fromConfig = config.glBibles?.map((b) => b.version).filter(Boolean) ?? [];
  return fromConfig.length > 0 ? fromConfig : ["ULT", "GLT"];
}

// Classic = the full current Shell: scripture column + a tabbed resource column
// (notes / words / questions). Must stay behavior-identical to today's Shell.
const classic: LayoutSpec = {
  v: 2,
  id: CLASSIC_LAYOUT_ID,
  name: "Classic",
  builtin: true,
  rail: { visible: true },
  root: {
    kind: "split",
    orientation: "horizontal",
    children: [
      {
        kind: "region",
        id: "scripture",
        size: 0.5,
        display: "stacked",
        panels: [
          { id: "scripture-1", type: "scripture", config: { mode: "stacked", versions: "inherit" } },
        ],
      },
      {
        kind: "region",
        id: "resources",
        size: 0.5,
        display: "tabs",
        panels: [
          { id: "notes-1", type: "notes" },
          { id: "words-1", type: "words" },
          { id: "questions-1", type: "questions" },
        ],
      },
    ],
  },
};

// Translate Notes: scripture on top, notes below (vertical split), rail hidden,
// pinned source+target scripture versions. Notes render source/target
// side-by-side (pairAxis horizontal).
function translateNotes(config: ProjectConfig): LayoutSpec {
  return {
    v: 2,
    id: "builtin:translate-notes",
    name: "Translate Notes",
    builtin: true,
    requires: "translation",
    rail: { visible: false },
    root: {
      kind: "split",
      orientation: "vertical",
      children: [
        {
          kind: "region",
          id: "scripture",
          size: 0.42,
          display: "stacked",
          panels: [
            {
              id: "scripture-1",
              type: "scripture",
              config: { mode: "stacked", versions: translateNotesVersions(config) },
            },
          ],
        },
        {
          kind: "region",
          id: "notes",
          size: 0.58,
          display: "stacked",
          panels: [{ id: "notes-1", type: "notes", config: { pairAxis: "horizontal" } }],
        },
      ],
    },
  };
}

// All built-ins whose `requires` is satisfied by the given config. Classic is
// always available; Translate Notes is shown only on a translation project.
// Order matches the client's getBuiltinLayouts so the server list and the
// bundled fallback are identical.
export function builtinLayoutsFor(config: ProjectConfig): LayoutSpec[] {
  const out: LayoutSpec[] = [classic];
  if (isTranslationConfig(config)) {
    out.push(translateNotes(config));
  }
  return out;
}
