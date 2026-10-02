# 06 — React port plan: 13 flow screens + verse overview

> Written 2026-08-07 by the flows-fidelity session. Governs the port of the
> `docs/flows/ui/` mockups into the React app, stacked on PR #152 (bands) →
> PR #151 (mockups + ReviewQueue). Read `02-architecture.md` (D1–D4) and
> `05-functional-preview-findings.md` first; this file only adds the
> port-specific decisions.

## Ground rules (all inherited, restated once)

- **New routes, additive only.** Every flow screen is a new component + hash
  route, following the `ReviewQueue.tsx` precedent. Existing workspaces
  (Shell, TemplateWorkspace, ImportWorkspace, PreferencesWorkspace…) are not
  restructured. The default entry point flips only when Benjamin says so.
- **Real data or honest emptiness.** No fabricated names, counts, or fixtures
  (finding: the two independent audits). Identity from `/api/auth/me`; empty
  and error states rendered honestly.
- **Breakpoints** come from `web/src/lib/layoutBands.ts` (`BAND_PX`:
  tablet=560, desktop=900) via `theme.breakpoints.up("tablet"|"md")` or
  `useLayoutBand`. Never `sm`/`lg` (MUI defaults, wrong values).
- **Semantic status colors are not brand accents** (D4). Use the new
  `theme.palette.flows` tokens (below), never `success`/`warning` for
  ok/warn/skip chips on flow screens.
- **i18n is deferred by precedent.** English literals with a `// TODO(i18n)`
  header comment per file, matching ReviewQueue. One sweep at the end adds
  keys across all flow screens at once.
- **No plain-text verse PATCH bodies for ULT/UST** — scripture edits flow
  through `smartEditVerse` (`web/src/lib/replace.ts`) + drafts + outbox, or
  save stays disabled (t4). A naive `{verseObjects:[{type:"text",…}]}` body
  destroys alignment and the server guard cannot catch total loss.
- **428 ≠ 409.** `precondition_required` is a client bug (log, re-read, retry
  once); only version 409s get the merge prompt; `chapter_locked` is not
  uniform across kinds (tn PATCH exempt; DELETE never locked).

## Routes (registered before the `#/{book}` catch-all in `parseHash`)

| Screen | Route | Component file (web/src/components/flows/) |
|---|---|---|
| t1 home | `#/home` | `HomeScreen.tsx` |
| t2 review | `#/review/{book}/{chapter}` (exists) | `../ReviewQueue.tsx` (stays) |
| t3 scripture | `#/scripture/{book}/{chapter}/{verse?}` | `ScriptureScreen.tsx` |
| t4 align | `#/align/{book}/{chapter}/{verse}` | `AlignScreen.tsx` |
| t5 articles | `#/articles` (bare; `#/articles/{tw\|ta}/{id}` still = old workspace) | `ArticlesScreen.tsx` |
| t6 words | `#/words/{book}/{chapter}/{verse?}` | `WordsScreen.tsx` |
| l1 AI | `#/ai` | `AiScreen.tsx` |
| l2 style | `#/style` | `StyleScreen.tsx` |
| l3 templates | `#/curate/{id?}` | `CurateScreen.tsx` |
| a1 setup | `#/setup` | `SetupScreen.tsx` |
| a2 import | `#/books` | `BooksScreen.tsx` |
| a3 team | `#/team` | `TeamScreen.tsx` |
| a4 observe | `#/observe` | `ObserveScreen.tsx` |
| verse overview | `#/verse/{book}/{chapter}/{verse}` | `VerseScreen.tsx` |

Since #537, the l1 AI, l2 style, l3 templates and a4 observe screens live at `#/admin/ai`, `#/admin/style`, `#/admin/curate/{id?}` and `#/admin/observe`; the old hashes above redirect there (`web/src/lib/legacyFlowRoutes.ts`).

Route names are single reserved tokens; none collide with USFM book codes
(3-char). Each wave registers its own routes; components are `React.lazy` so
a screen's weight isn't paid on unrelated routes.

## Foundation (this stack's first commit)

1. **Theme**: extend `web/src/theme.ts` with a `flows` palette group —
   `ok`/`warn`/`skip`, each `{ main, ink, soft }`, light+dark values lifted
   from `_tokens.css` — via TS module augmentation. Plus
   `SCRIPTURE_FONT_STACK` (Iowan Old Style / Charter / Palatino / Georgia)
   exported from theme.ts for scripture text blocks.
2. **Shared primitives** in `web/src/components/flows/` (styled after
   `_tokens.css`, MUI-based, logical properties only):
   - `FlowStatusChip` — draft/approved/edited/trashed/ok/warn/skip chips.
   - `FlowBanners` — `LockBanner` (chapter-locked, from real 409 body:
     pipelineType + startedAt, never a fabricated editor name) and
     `ReadyBanner` (AI drafts ready).
   - `FlowActionBar` — fixed bottom action bar for <900px bands (WCAG 2.5.8:
     min 24px targets; mockups measured 22–23px failures — don't copy them).
   - `FlowNav` — persona-grouped pill nav (Translator/Lead/Admin; Admin group
     role-gated). MUST remain reachable below 700px (mockup defect: Admin
     screens lose all nav under 700px) — collapses to a menu, never vanishes.
3. **Docs**: this file.

## Waves

- **Wave T (translator)**: t1 (S), t2 fidelity pass (L — the 19-gap list in
  the session record), t5 (M), t6 (M).
- **Wave S (scripture)**: t3 (L — save enabled via smartEditVerse path),
  t4 (L — alignment view; save disabled with an honest explanation, reusing
  aligner leaf components where practical; mobile shows the graceful
  "larger screen" state).
- **Wave L (lead)**: l1 (M — menu models translate-tq as `translate` +
  `resourceType:"tq"`), l2 (M — first-write `If-Match: 0`), l3 (M — Approve
  disabled with explanation while `translation_state` is NULL).
- **Wave A (admin)**: a1 (M — preset 409 `project_not_empty` honest state),
  a2 (L — most endpoints; lane-replacement dual shape: chapter GET omits the
  lane silently, verse GET 409s `lane_replacement_required`), a3 (S/M —
  check `body.error === "dcs_401_public_only"` even on 200), a4 (M — stage
  editor stays a no-backend stub with up/down buttons, no native DnD).
- **Wave V (verse overview)**: port of `docs/mockups/book-package/verse.html`
  — Read mode (Original/Literal/Simplified stacked, click-to-highlight
  across all three anchored on original words) + Audit mode (one row per
  original word: Hebrew | Literal | Simplified | marks). Data via
  `useChapter` (verses content_json alignment trees, tn/tq/twl rows).
- **Wave i18n**: one sweep converting all flow-screen literals to i18next
  keys across the 14 locale files.

Per-wave gate: `npm run typecheck`, `npm run build`, browser smoke test on a
worktree dev server, then commit. PRs stack: foundation+T → S → L+A → V.

## Required states (acceptance bar, per 02-architecture)

Every relevant screen renders: chapter-locked banner (reactive), 409 merge
prompt (from real payload), drafts-ready banner, "N unsaved" reminder,
context-pack chip, AI-not-configured calm state, mode gating
(authoring/translation), "x of y" counters, org-switch-reloads-app.
