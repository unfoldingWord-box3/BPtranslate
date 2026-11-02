// In-app guide lookup — maps the current screen to its help article.
//
// The guide's own `routes:` front-matter (help/<lang>/*.md, format in
// help/README.md) is the registry: an article lists the route keys it explains,
// and the build (scripts/build-help.mjs) bundles that into the generated index.
// This file only looks routes up in an index it is handed — it never imports the
// generated JSON — so there is nothing here to keep in sync by hand.
// Coverage is enforced by guideMap.test.mjs: every `view` in App.tsx's
// `Location` type (and every admin desk section) must be listed by some English
// article, and every listed key must still exist, or
// `npm --workspace web run test` fails with instructions.

export interface HelpArticle {
  id: string;
  title: string;
  routes: string[];
  roles: string[];
  keywords: string[];
  headings: string[];
  body: string;
}

export interface HelpIndex {
  version: 1;
  langs: Record<string, { articles: HelpArticle[] }>;
}

/** The part of App.tsx's `Location` this lookup needs. */
export type HelpLocation = { view: string; section?: string };

/**
 * Route key for a screen: `admin/<section>` on the admin desk, otherwise the
 * bare view name. Preferences' section is ignored on purpose — the whole
 * classic preferences page is one article.
 */
export function routeKey(loc: HelpLocation): string {
  return loc.view === "admin" ? `admin/${loc.section}` : loc.view;
}

/** Articles for `lang`, falling back to English when that language has none. */
export function articlesFor(index: HelpIndex, lang: string): HelpArticle[] {
  const own = index.langs[lang]?.articles;
  return own && own.length > 0 ? own : (index.langs.en?.articles ?? []);
}

/** The article that lists `key` under `routes:`, or null. */
export function articleForRoute(index: HelpIndex, lang: string, key: string): HelpArticle | null {
  return articlesFor(index, lang).find((a) => a.routes.includes(key)) ?? null;
}
