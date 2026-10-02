# In-app user guide

This folder is the source of the Help panel's guide. Each language has its own
folder of Markdown articles (`en/`, `ar/`); screenshots live in
`screenshots/<lang>/`. `scripts/build-help.mjs` turns them into the files the app
reads, so **edit here, never the generated files**.

## When to update it

Change a user-visible flow (a screen, a button, a route, a step), then:

1. Update the matching article in `help/en/` **and** `help/ar/`.
2. Rerun the screenshots: `npm run guide:screenshots` (see below).
3. Regenerate: `node scripts/build-help.mjs` (CI runs it with `--check` and
   fails when the generated files are stale).

A new screen (a new `view` in `web/src/App.tsx`'s `Location` type, or a new
admin desk section) fails `npm --workspace web run test` until some article
lists it under `routes:`. That guard is `web/src/help/guideMap.test.mjs`.

## Article format

One file per article: `help/<lang>/<NN>-<id>.md`. `NN` orders the table of
contents. The same `id` must exist in every language folder.

```markdown
---
id: notes
title: Translating notes
routes: [notes]
roles: [editor, admin]
keywords: [note, tn, translation notes, save, draft]
screenshots:
  - notes-1 #/notes/OBA/1/1
  - notes-phone #/notes/OBA/1/1 phone
---

Intro paragraph: what this screen is for, in one or two sentences.

![The Notes screen](../screenshots/en/notes-1.png)

## Open a note
1. ...
```

Front-matter fields (a small fixed subset of YAML: `key: value`,
`key: [a, b]`, and `key:` followed by `  - item` lines):

| Field | Meaning |
|---|---|
| `id` | Stable article id, lowercase-kebab. Links between articles use it: `[Notes](#help:notes)`. |
| `title` | Shown in the Help panel's list and search results. |
| `routes` | Route keys this article explains. A route key is a `view` from `Location` in `web/src/App.tsx`, or `admin/<section>` for the admin desk. The Help panel opens to the article that lists the current screen's key. Each key belongs to exactly one article. |
| `roles` | Who the article is for: any of `editor`, `admin`, `viewer`. |
| `keywords` | Extra words for search, including words a user might type that the text doesn't use. |
| `screenshots` | English articles only. One line per picture: `<name> <hash> [phone] [top]` (flags in any order). The capture run opens `<hash>` on the seeded test data (book OBA) in each language and saves `screenshots/<lang>/<name>.png`. `phone` captures at phone width instead of desktop. `top` scrolls the page and every scrollable area back to the top before the picture, for screens that open part-way down. |

Body rules:

- Write task walkthroughs: what the screen is for, then numbered steps for the
  common jobs. Use the button and menu labels exactly as the UI shows them in
  that language (`web/src/i18n/locales/<lang>.json`).
- Images reference `../screenshots/<lang>/<name>.png`, which renders on GitHub
  and is rewritten to the app's `/help/<lang>/<name>.png` by the build.
- Link another article with `#help:<id>`.

## Screenshots

`npm run guide:screenshots` starts its own API + web servers on free ports
against throwaway local databases, signs in as a dev admin, and captures every
`screenshots:` line in each language. A Playwright `setup` project first
onboards two translation-mode workspaces and imports OBA into them through the
app's own API (`tests/guide/seed.setup.ts`, `tests/guide/target.ts`): English
pictures come from the `mltest` workspace (preset `en-bible-editor-ml-test`,
English pulled from unfoldingWord), Arabic pictures from `bsoj` (preset
`ar-bsoj`). It fails loudly if onboarding or import fails. The PNGs are committed.
The run needs the same local setup as the e2e suites (see
`playwright.guide.config.ts`). On Ubuntu 26.04 set
`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`.
Scripture renders right only with a Hebrew font that has cantillation marks and
an Arabic font that has alef wasla: on Debian/Ubuntu install `fonts-sil-ezra`
and `fonts-noto-core`. The capture maps the app's reading-font names to them
for those scripts only (`tests/guide/capture.spec.ts`).

## Arabic status

The Arabic articles are a machine translation of the English ones and have had
no native-speaker review yet, the same status as the Arabic UI strings
(`docs/i18n.md`). Reports from Arabic-speaking users are the review channel; fix
the article they point at.
