// Shared by seed.setup.ts and capture.spec.ts: which seeded workspace each
// guide language is captured from, and which book was imported into it.
// The default dev config (api/wrangler.toml WORKSPACES) has two workspaces.
export const GUIDE_BOOK = "OBA";

export interface GuideWorkspace {
  slug: string;
  // Project preset applied through PUT /api/project-config (the call the Setup
  // wizard's Apply makes). Both presets are translation-mode projects.
  preset: string;
  // true: pull English from the project's translationSource (unfoldingWord)
  // into an English gateway-language project. false: load the org's own repos.
  translateFromSource: boolean;
}

export const WORKSPACES: Record<string, GuideWorkspace> = {
  // English gateway-language project (BibleEditorMLTest org, repos are empty).
  en: { slug: "mltest", preset: "en-bible-editor-ml-test", translateFromSource: true },
  // BSOJ: translating from unfoldingWord English into Arabic (ar_avd / ar_nav).
  ar: { slug: "bsoj", preset: "ar-bsoj", translateFromSource: false },
};

export function workspaceFor(lang: string): GuideWorkspace {
  return WORKSPACES[lang] ?? WORKSPACES.ar;
}
