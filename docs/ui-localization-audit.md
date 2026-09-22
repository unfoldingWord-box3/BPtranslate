# UI localization audit — 2026-07-31

Full sweep of `web/src` for user-visible text that does not go through i18next,
plus the locale-file completeness gap. Ordered by how much a translator notices.

**THREE separate problems**, and only the first is visible to a code review:

1. **~156 strings are hardcoded English in the source** — no `t()` call, so no
   locale file can ever translate them. (§1–§2)
2. **~420 keys per locale are missing**, so i18next falls back to English. (§4)
3. **~170 keys per locale are *present but hold the raw English string*.** (§5)
   This is the one that matters most for process: `scripts/check-i18n.mjs` counts
   these as satisfied, and a code review sees a correct `t()` call. Only looking
   at the running app in Arabic finds them. This is the evidence for the
   two-halves rule now in `CLAUDE.md`.

A worked example of why all three must be checked separately — three ways the
Preferences page shows English under an Arabic UI:

| what the user sees | key exists in `en.json`? | key exists in `ar.json`? | failure mode |
|---|---|---|---|
| find/replace tooltips | no | no | hardcoded (#1) |
| "Layouts", "Manage layouts" | yes | **no** → falls back | missing key (#2) |
| "Common issues", "User management", "Note Templates" | yes | yes, **value is the English string** | untranslated value (#3) |

## 1. Files with NO i18next import at all

These render only English, in every language. Verified by grep: zero
`useTranslation` and zero `t(` in each.

| file | findings | what the user sees |
|---|---|---|
| `web/src/App.tsx` | 16 | **the entire sign-in / not-authorized / session-expired surface** — the first screen a translator ever sees |
| `web/src/components/AppErrorBoundary.tsx` | 6 | the crash screen ("Something went wrong", "Reload") |
| `web/src/components/UnsavedToasts.tsx` | 6 | unsaved-draft reminders and their Save buttons |
| `web/src/components/SourceTooltipBody.tsx` | 4 | original-language word tooltip ("Grammar", "double-click to pin") |
| `web/src/components/TwArticleDialog.tsx` | 5 | tW article dialog + its error/empty states |
| `web/src/components/CopyChapterButton.tsx` | 4 | copy-chapter tooltip, all three states |
| `web/src/components/PinnedLexBox.tsx` | 2 | pinned lexicon box aria-labels |
| `web/src/components/AiCompletionToasts.tsx` | 2 | AI-draft toast ("View", "dismiss") |
| `web/src/hooks/useAiDrafts.ts` | 1 | "AI draft ready" notification text |

### App.tsx (16)

| line | string | renders as |
|---|---|---|
| 339 | "signing in…" | auth loading screen |
| 356 | "You're signed out" / "Sign in to continue" | heading |
| 360 | "Queued edits stay in your browser until you sign back in." | body |
| 364 | "Sign in with Door43" | button |
| 368 | "Sign in (dev)" | button (dev only) |
| 377 | "Not authorized" | heading |
| 380–381 | "Your DCS account … isn't on the editor allowlist for this app yet." | body (2 variants) |
| 382 | "If you should have access, ask an admin to add you." | body |
| 396 | "Sign in with a different Door43 account" | button |
| 404 | "auth failed: " | error alert prefix |
| 480 | "view run" | link in alert |
| 489 | "You're signed in as an unfoldingWord member — read-only access…" | viewer banner |
| 577 | "Sign in" | snackbar action |
| 581 | "Your session expired — sign in to keep saving…" | snackbar body |

### Other no-i18n components (26 total)

| file:line | string | renders as |
|---|---|---|
| AppErrorBoundary.tsx:76 | "Update needed" / "Something went wrong" | heading |
| AppErrorBoundary.tsx:79–80 | chunk-reload body / generic crash body | body |
| AppErrorBoundary.tsx:83 | "Reload" | button |
| CopyChapterButton.tsx:37 | "Copied!" / "Copy failed" / "Copy chapter (for Word)" | tooltip |
| CopyChapterButton.tsx:41 | "copy chapter" | aria-label |
| PinnedLexBox.tsx:67,81 | "copy lexical form", "close" | aria-label |
| SourceTooltipBody.tsx:45 | "double-click to pin" | hint |
| SourceTooltipBody.tsx:161 | "Grammar" | section label |
| SourceTooltipBody.tsx:167 | "+ attached pronoun" | row text |
| SourceTooltipBody.tsx:205 | "no lexicon entry — stub in source resource" | empty state |
| TwArticleDialog.tsx:98,116 | "View on DCS", "Open on Door43" | link |
| TwArticleDialog.tsx:101 | "close" | aria-label |
| TwArticleDialog.tsx:109 | "No Translation Words source is configured for this project." | empty state |
| TwArticleDialog.tsx:113 | "Couldn't load this article." | error |
| UnsavedToasts.tsx:108,138,158 | "Review", "collapse", "Save" | button |
| UnsavedToasts.tsx:112 | "{n} unsaved edits off-screen" | alert body |
| UnsavedToasts.tsx:170 | "dismiss" | aria-label |
| UnsavedToasts.tsx:186 | "Save {book} {chapter}:{verse} {version}?" | alert body |
| AiCompletionToasts.tsx:80,87 | "View", "dismiss" | button / aria-label |
| useAiDrafts.ts:194 | "AI draft ready" | notification |

## 2. Partially localized files — the gaps

### FindReplaceOverlay.tsx (~33)

The heaviest single file. Every tooltip, both scope checkboxes ("Bible", "TN"),
`find`/`replace` placeholders, the result summary, and the entire "Replace all?"
confirm dialog are English. Lines 735, 739, 747, 758, 770, 782, 792, 796, 806,
814, 828, 849, 871, 873, 879, 883, 895, 899, 921, 924, 934–935, 953, 960–961,
973, 983, 988, 1014–1033, 1039, 1043–1048, 1053, 1062–1063.

### History dialogs (~38)

`NoteHistoryDialog.tsx` and `VerseHistoryDialog.tsx` are almost entirely
unlocalized: dialog titles, every version chip ("current", "created",
"imported", "deleted", "pre-AI", "text only"), the snapshot/diff toggle, field
labels ("Support ref", "Quote", "Note"), "pick a version on the left to
preview.", "Close", "Already current" / "Switch to v{n}", "(empty)", "unknown".
`TemplateHistoryDialog.tsx` is clean by contrast — use it as the model.

NoteHistoryDialog lines 59, 163, 174, 185, 219–244, 292–295, 301–331, 339, 347,
358–362, 410. VerseHistoryDialog lines 43, 49–50, 127, 137, 148, 180–193,
220–221, 233–235, 246–248, 253, 262–263, 266, 277–280, 304, 330.

### TwlSuggestions.tsx (10)

Whole panel: heading "Suggestions", "Suggestions paused — Words checked here",
"reopen", every tooltip ("re-scan this verse", "add this link", "reject
suggestion", "read article"), "couldn't load suggestions", "no new links
suggested for this verse". Lines 205–344.

### QuoteBuilderPopper.tsx (13)

Header "Build quote · {book} {chapter}:{verse}", "shift-click for a range",
"Preview", "occurrence {n}", "Cancel", "Use selection", and all four
no-alignment empty states. Lines 200–337, 430, 484.

### Shell.tsx (17)

Localized overall, with four specific leaks:
- `"unknown error"` — the fallback interpolated into eight otherwise-translated
  error messages (lines 804, 823, 839, 869, 883, 911, 936, 954).
- Four AI-prerequisite messages (2883–2888): "ULT verse text unavailable for
  this verse.", "UST verse text unavailable…", "Couldn't match this English to
  the ULT alignment…", "AI prerequisites missing."
- `"— panel coming in a later pass"` (3351).
- `formatRelative`'s time suffixes "s ago" / "min ago" / "h ago" / "d ago"
  (3958–3961), rendered inside the otherwise-translated chapter-lock banner.

### BookView.tsx (8) and DocColumn.tsx (5), ChapterBoard.tsx (1)

Per-verse icon tooltips, built by template so a grep for quoted prose misses
them: `align verse ${n}`, `undo edits to verse ${n}`, `save verse ${n}`,
`Text — ${attribution}`. Plus "chapter {n} loading…", "(scroll to load)",
"chapter {n} failed to load: …", "front", "intro", and DocColumn's
"read-only" / "editing" caption. BookView 429–1003, DocColumn 180–708,
ChapterBoard 254.

### WordsTable.tsx (2), ResourceColumn.tsx (1)

"show in text" (aria-label), the tW-article picker placeholder, and the `"i"`
intro abbreviation in the resource header.

### ImportFromDoor43Dialog.tsx (10)

The dialog chrome is localized; `summarize()` (lines 85–98) builds the entire
success message from English literals — "updated", "inserted", "skipped
(already edited)", "skipped (AI pipeline running)", "unchanged", "source-attr
fix(es) synced from master", "resource(s) not on DCS", "Imported {book} — no
changes.". (Unrelated nit: the local variable is named `t`, shadowing the
i18next `t`.)

### PreferencesWorkspace.tsx (1)

Line 845 — `https://git.door43.org/owner/repo` placeholder. Borderline: it's
example syntax, not prose.

## 3. Confirmed clean

`TopBar.tsx`, `ScriptureColumn.tsx`, `NoteCard.tsx`, `QuestionCard.tsx`,
`QuestionsTable.tsx`, `ArticleWorkspace.tsx`, `TemplateWorkspace.tsx`,
`TemplateHistoryDialog.tsx`, `AlignmentPanel.tsx`, `SideBySideAligner.tsx`,
`UhbStrip.tsx`, `LaneReplacementDriver.tsx`, `PipelineMenu.tsx`,
`PipelineStatusBar.tsx`, `SetupWizard.tsx` + `lib/setupWizard.ts`,
`ImportWorkspace.tsx`, `UserManagementSection.tsx`, `WorkspaceSwitcher.tsx`,
`BookSourceOverridesPanel.tsx`, `LocalizationInspector.tsx`,
`StackedResourcePanel.tsx`, `WorkspaceLayout.tsx`, `SyncStatusBar.tsx`,
`StatusIndicator.tsx`, and the remaining panel components.

## 4. The locale-completeness gap

`node scripts/check-i18n.mjs` fails today:

- **~419 of 1,160 base keys missing in every one of the 13 non-English locales.**
  The bulk is `books.*` (`abbr` + `name` for all 66 books — every book name in
  the app's navigation is English in every language), plus `topbar.status.*`,
  `topbar.more.*`, `workspace.choose*`, `translation.sourceAxis*`.
- **29 stale keys** present in the locales but no longer in `en.json` —
  `setup.*` import/populate copy, `logos.*`, `topbar.*` text-size controls,
  `sync.buildSha`.

Fix the stale keys first (cheap, mechanical), then the `books.*` block (66 × 2 ×
13 = 1,716 values, but book names are well-known in every target language), then
the remainder.

## 5. Untranslated values — present keys holding English text

Measured by comparing each locale's value against `en.json`'s, counting only
values that are byte-identical and contain a real Latin word:

| locale | keys present | identical to English | locale | keys present | identical to English |
|---|---|---|---|---|---|
| ar | 841 | **166** | fa | 784 | 173 |
| es | 798 | 181 | bn | 784 | 172 |
| fr | 798 | 189 | ne | 784 | 172 |
| pt | 798 | 177 | sw | 784 | 171 |
| ru | 812 | 172 | ur | 784 | 171 |
| hi | 785 | 173 | id | 770 | 178 |
| th | 770 | 174 | | | |

So Arabic, the most complete locale, ships 841 keys of which 166 (20%) are
English. Combined with the 423 missing keys, **roughly half of the Arabic UI
renders in English** even though every one of those strings is correctly wired
to `t()`.

Examples confirmed in the running app: `templates.title` ("Note Templates"),
`preferences.section.commonIssues` ("Common issues"), `preferences.users.title`
("User management"), `preferences.commonIssuesIntro`,
`preferences.commonIssuesPlaceholder`.

**`check-i18n.mjs` cannot catch this** — the key is present, so it passes. Worth
adding a `--strict-values` mode that flags identical-to-English values as a
warning (with an allowlist for strings that are legitimately the same, e.g.
"OK", product names).

## 6. Browser-pass findings not attributable to the code sweep

From clicking through the app at `be:uiLang=ar`, `dir=rtl`. These are either
mode-#2/#3 fallbacks or genuinely dynamic strings.

### A live bug, not a translation gap

- **TopBar → More → "Import from Door43"**: the secondary text renders as
  `Pull ULT/UST, notes & questions in ` — the trailing interpolation resolves
  **empty**, so the sentence is truncated mid-thought. Fix the interpolation, not
  the string.

### Locale-blind date formatting

`toLocaleString()` / `toLocaleDateString()` is being called without a locale
argument, so dates render **en-US under Arabic**:
- note version chip tooltip → `7/21/2026, 10:52:48 AM`
- note-history dialog
- Preferences → Users table → `ADDED` column → `7/21/2026`

### Accessibility gaps — nothing to translate because nothing is labelled

No `aria-label`, no `title`, no tooltip at all on: the **prev/next chapter
arrows**, the **note Save icon button**, and the **note reorder up/down arrows**.
Screen readers announce nothing.

### MUI defaults

The book and chapter `Select` components expose MUI's untranslated `Open` as both
`aria-label` and `title`. Invisible to a source grep; needs MUI's own
localization provider or an explicit override.

### English fragments spliced into Arabic strings

- Alignment button aria-label: `محاذاة NAV — has unaligned words` (English tail
  concatenated onto a translated label).
- Note card TCM/SH chip tooltips: `التعبئة بقالب "This could mean"` — the Arabic
  frame is right, the interpolated template name is English.
- Localization tab description splices `العربية` into an English sentence.

### Namespace keys and metadata rendered as visible UI

- Preferences → Localization tab category headers are raw i18n namespace
  identifiers, uppercased: `TOPBAR (48)`, `PANELTITLE (10)`, `NOTECARD (49)`,
  `PANELBODY (9)` … 25 of them. Never string literals in source.
- Note Templates group headers come from template metadata:
  `ASSUMED KNOWLEDGE`, `QUOTE MARGIN "SAYING," "AND SAID"`,
  `INDEPENDENT PRONOUN - REFERENT FOCUS`, and ~22 more.

### Interpolated counters and labels

`0 / 20000 characters`, `0 / 50000 characters`, `0/194 approved`,
`1/66 imported`, `5 ch · loaded 3`, `RUT — 10 issues to clean up`,
`build 32e2e78 · up to date`, `chapter 1` / `(scroll to load)`,
`BSOJ (العربية) · switch`, `current: v1` / `preview of v1`.

### Whole surfaces rendering in English

Each of these was reported "fully localized" by the code sweep — correctly, they
all call `t()`. They render English via mode #2/#3:

- **Preferences**: left nav (`Common issues`, `Setup`, `Localization`, `Users`),
  org header + its description, Instructions/Common-issues headings and
  counters, terminology row labels and placeholder, Localization tab, the whole
  Setup wizard (step labels + step 1 body + Scripture repositories section), and
  the entire Users tab (form, table headers, both roster sections, empty states).
- **Note Templates page** (`TemplateWorkspace`): title, `0/194 approved`,
  `Search templates`, all group headers, `(built-in)`, `DRAFT WITH AI`, `SAVE`,
  `PREVIEW`, `History`.
- **Import Books page**: title, `1/66 imported`, `Imported` / `Not imported`
  chips, all 66 book names, `Select a book to import.`
- **Layouts menu + dialogs**: `Layouts`, `Classic`, `Flexible`,
  `Translate Notes`, `Save current as…`, `Manage layouts…`, `Manage layouts`,
  `You haven't saved any layouts yet.`, `Save layout`, `Layout name`.
- **Panel chrome in Flexible/Translate-Notes layouts**: `Drag to move this
  panel`, `Minimize panel`, `Close this section`, every panel title
  (`Scripture`, `translationNotes`, `translationWords`, …), and both
  "Select a … article." empty states.
- **TopBar**: `Saved` chip and its whole status popover (`STATUS`,
  `All edits saved to the cloud`, `No AI pipelines running`), `More` + its
  section headers (`Content`, `Resources`, `View`) and every item, account menu
  (`MODE`, `Editor`, `Translator`, `Organization`), AI menu (`Pull Aquifer
  drafts`, `Re-source notes from English` + both descriptions), view-mode
  tooltips, `copy chapter`, `Back to scripture`.
- **All 66 book names** in the book selector — `books.*` is the single largest
  missing block (132 keys × 13 locales).

### Surfaces not reached

The replace-all confirm dialog (destructive), Setup wizard steps 2–5 (advancing
mutates workspace config), the Import Books detail pane, AI-pipeline
running/progress/error states (~89 keys in the `pipeline` namespace — needs a
real run), the sign-in screens (dev auth auto-mints past them), the UI-language
dropdown list, the verse-history dialog (needs an edited verse), and
verse-status / 409-conflict / offline-outbox states (need induced failures).

Method caveat: the browser pane reported a 0×0 viewport and screenshots timed
out, so all interaction was driven by synthetic DOM clicks. That is why several
MUI popups refused to open — those gaps are tooling limits, not missing
surfaces. All recorded text was read from the live DOM with `dir=rtl` and
`be:uiLang=ar` confirmed.

## How this was produced

Four parallel read-only code sweeps over all 128 files in `web/src` (JSX text
nodes; `title`/`label`/`placeholder`/`helperText`/`aria-label`/`alt` props;
`window.confirm`/`alert`; thrown/rendered error text; label maps), cross-checked
against each file's `useTranslation` import. Then a browser pass driving the real
app at `be:uiLang=ar` / `dir=rtl` through every reachable menu, dialog, panel,
tab, tooltip and empty state.

`scripts/check-i18n.mjs` was run for the missing-key count. The
identical-to-English counts in §5 come from a direct value-by-value comparison of
each locale against `en.json`. The "no i18next import" claim was independently
re-verified by grep, and the three-failure-mode reconciliation in the header was
verified key-by-key against `en.json` / `ar.json`.

Not verified: individual line numbers from the code sweeps (accurate to within a
few lines, not re-confirmed by hand), and the surfaces listed as unreached above.

## Suggested order of work

Each of these is a separate, single-idea PR.

1. **`App.tsx` + the eight other no-i18n files** — the sign-in and crash screens
   are the highest-visibility English in the product.
2. **Fill `books.*`** (132 keys × 13 locales) — every book name in navigation,
   one mechanical change, largest single visible win.
3. **Translate the ~170 identical-to-English values per locale**, starting with
   `ar`, and add a `--strict-values` mode to `check-i18n.mjs` so it can't recur.
4. **Fill the remaining ~290 missing keys per locale**, and delete the 29 stale ones.
5. **FindReplaceOverlay + the two history dialogs** (~71 hardcoded strings).
6. **The small stuff**: locale-aware date formatting, the empty-interpolation bug
   in More → Import, the missing aria-labels, MUI's `Open` default.
7. **Wire `check-i18n.mjs` into CI** so none of this regresses.
