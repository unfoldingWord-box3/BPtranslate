# CLAUDE.md

> Deployed to `https://bible-editor-api.unfoldingword.workers.dev` (Cloudflare Workers, unfoldingWord account). The default env in `api/wrangler.toml` carries dev-friendly values for `wrangler dev` and is named `bible-editor-api-dev` with **no crons**, so a plain `wrangler deploy` lands on a separate dev worker instead of overwriting prod; prod (worker name `bible-editor-api`, crons registered) lives under `[env.production.*]` and ships via `wrangler deploy --env production`. Any `--remote` D1 / `wrangler secret` / `wrangler tail` command needs `--env production` to target the deployed worker.

> **Dev D1 database separated.** Created `bible_editor_dev` (ID: `ceb458bf-4608-4696-a087-9026618a6cef`) as the default remote target for `wrangler d1 ... --remote`. Production ID (`7e566abf-454d-43d6-b24e-11df74f1c0ed`) is isolated to `[env.production.*]` so `wrangler deploy --env production` targets prod only. `wrangler dev` (local) remains unchanged — it uses a local SQLite file and never touches remote.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Agent orchestration — default pattern

**The main conversing session is the orchestrator.** This is a large codebase; keep the main thread lean (target <200k tokens, never exceed 400k). Default to subagents for anything that isn't a trivial one-liner:

- **Exploration / research** — any question that takes more than 2–3 grep/read calls → `Explore` or `general-purpose` Agent.
- **Implementation** — spawn a worktree Agent for non-trivial edits so the main thread doesn't accumulate file content.
- **Parallel work** — fire independent tasks (e.g. read STATE.md + read docs/plan.md) simultaneously as multiple Agent calls in one message.
- **Verification** — delegate browser smoke-test and build runs to an Agent.
- **When NOT to subagent:** single-file edits already identified, direct answers to "what does this variable do", or trivial grep lookups you can do in one tool call.

Rule of thumb: if you'd open more than two files or run more than two bash commands to complete it, delegate it.

## Context

- Tactical 7-month replacement for gatewayEdit + tcCreate. Read [`docs/plan.md`](docs/plan.md) and [`docs/handoff.md`](docs/handoff.md) before non-trivial work. If a wave-specific handoff exists (e.g. [`docs/wave-2-handoff.md`](docs/wave-2-handoff.md)), read that first.
- We borrow a lot of code from `../tcc-ge-dcs` — look there for help/inspiration.
- We are intentionally rethinking the backend to remove DCS from the loop except for once daily.
- Volta-pinned: Node 24.15.0, npm 11.12.1. npm workspaces (`api/`, `web/`).

## Session state — read first, update last

State is split across two places, and the split is load-bearing. **The agent forgets between sessions; these files do not.**

[`STATE.md`](STATE.md) holds only what the project **is**: what's blocked on a human (**Escalated**), the durable lessons that aren't in the code (**Lessons learned**), and standing goals. `.claude/state/<worktree-name>.md` holds in-flight status for one worktree — one small file, deleted when its PR merges.

- **At the start of non-trivial work:** read `STATE.md`, plus `.claude/state/<this-worktree>.md` if it exists. It complements the standing spec (this file + `docs/plan.md`): state says where the work is, the spec says where it's going.
- **`STATE.md` must not contain a session log.** No "Last run", no "Completed", no "In progress" — those sections were removed on 2026-07-20 because every parallel worktree wrote them at the same anchor line, so the file conflicted on essentially every merge (the log had reached ~1,780 of 1,866 lines). Read `STATE.md`'s own header before editing it; it states the rule authoritatively.
- **Before you finish:** what just happened goes in **the commit message and the PR description** — written once per branch, structurally incapable of conflicting. Anything still mid-flight goes in `.claude/state/<worktree-name>.md`. Only two things go in `STATE.md`: a new human blocker under **Escalated**, or a durable cross-session fact under **Lessons learned** (there, not in chat).
- **Never commit a `STATE.md`-only change to main.** A note *about* a PR belongs in that PR's thread; a code-free commit to a shared file makes every open branch stale.
- **Parallel worktrees:** separate `.claude/state/` files never collide. A conflict that does survive in `STATE.md` is now meaningful — two sessions learned contradictory things, and that's worth stopping for. The canonical copy lives on `main`; rebase before relying on it, and don't delete other branches' entries.

## Before planning, and again before executing

Multiple worktrees may be active in parallel. Twice — once before writing the plan, and again immediately after the plan is approved and before any edits — run:

```sh
git fetch origin main && git log --oneline HEAD..origin/main
```

Surface any commits the worktree is behind by, plus whether they touch files this plan will modify. Don't silently base a plan on a stale tree, and don't start executing without re-checking — main may have advanced between writing the plan and the user approving it (other worktrees may have landed work during the approval window).

## Pull requests

Before creating or pushing to a PR, run:

```sh
gh pr view --json state,mergedAt 2>/dev/null
```

If the PR for the current branch was already merged, **do not push to the same branch**. Rebase onto main, create a new branch, and open a fresh PR. This happens regularly: a PR is merged, the user tests on local main, requests a tweak, and a new PR is needed for the follow-up change.

**This checkout has both `origin` (`deferredreward/bible-editor-multilingual`, this fork) and `upstream` (`unfoldingWord/bible-editor`) remotes.** `gh pr create` / `gh pr view` / `gh pr close` without an explicit `--repo` can resolve against `upstream` instead of `origin` and open or act on a PR in the wrong repo. Before any `gh pr *` command, confirm the target with `gh repo view --json nameWithOwner` (or pass `--repo deferredreward/bible-editor-multilingual` explicitly) — don't assume `gh`'s default matches where the branch was pushed.

## Committing

Commit messages with a body: pass repeated `-m` flags (`git commit -m "subject" -m "body para" -m "Co-Authored-By: …"`). Do **not** use PowerShell here-string syntax (`@'…'@`) for the message — these git commands run through the **Bash** tool, where `@'…'@` is not heredoc and leaks a literal `@` into the subject line.

## Common commands

Run from repo root:

```sh
npm install
npm run dev          # parallel: wrangler (api, :8787) + vite (web, :5173 with /api proxy)
npm run typecheck    # tsc --noEmit across both workspaces
npm run build        # api typecheck + web vite build → web/dist
npm run deploy       # builds web, then `wrangler deploy` from api/ (bundles SPA as [assets])

npm run test:e2e     # Playwright concurrency suite (auto-starts dev server)
npm run test:e2e:ui  # same, with Playwright UI

# single Playwright test
npx playwright test tests/concurrency/s2-same-verse.spec.ts -g "<grep>"
```

API-only operations (from `api/`):

```sh
npx wrangler d1 migrations apply bible_editor_dev --local                   # apply migrations locally
npx wrangler d1 migrations apply bible_editor --remote --env production     # apply migrations to prod
npx wrangler d1 execute bible_editor_dev --local --file=../scripts/out/import-ZEC.sql
npm run tail                                                                 # wrangler tail (live API logs)
```

Web-only:

```sh
npm --workspace web run test    # strip-types runner: alignment, morph, replace, sourceOccurrences suites
```

Importing books / lexicon (from repo root):

```sh
node scripts/import-book.mjs ZEC      # generates scripts/out/import-ZEC.sql
node scripts/import-lexicon.mjs       # UHAL + UGL → scripts/out/import-lexicon.sql
```

**Never create scratch/test directories at the drive root.** No `C:\bem-verify`, no `C:\tmp-*`, no `--persist-to "C:/anything"`. The whole repo was relocated to the short path `C:\GH\BEM\repo` precisely so that a worktree under `.claude/worktrees/<name>` still fits inside Windows' `MAX_PATH` — so `wrangler dev` / `d1 ... --local` need no escape hatch and can use their default in-worktree `.wrangler/state`. If a run genuinely needs a `--persist-to`, point it inside the worktree (e.g. `--persist-to ".wrangler/verify"`), and pass the same value to **every** command in the sequence (migrate AND seed AND dev) or the seed lands in a different SQLite file and looks silently empty. Anything truly throwaway goes in the session scratchpad directory, never on `C:\`.

Fresh git worktree: run `scripts/worktree-init.ps1` from the worktree root — it runs a real (cache-fast) `npm install` so the worktree is self-contained. **Teardown: always use `scripts/worktree-cleanup.ps1` (dry-run by default; `-Remove '<path>'` to delete one). Never `rm -rf` / `Remove-Item -Recurse` a worktree by hand.** The init script no longer junctions `node_modules` from main: junctions were a Windows footgun — a recursive delete of a worktree followed the junction and wiped main's `node_modules` and (via npm's `@bible-editor` workspace links) main's `web/`+`api/` source. `worktree-cleanup.ps1` safely unlinks any leftover junctions (link only, never the target) before deleting.

**There is no overnight cleanup task for this repo, despite what this file used to claim.** A definition sat in `~/.claude/scheduled-tasks/bible-editor-worktree-cleanup/` from 2026-07-20 but was never registered anywhere, and could not have worked regardless: Claude Code routines are *cloud* agents with no access to this machine's disk. Nothing was ever auto-removed, which is why worktrees accumulated here. A real, local Windows Scheduled Task now runs `C:\GH\dotfiles\windows\Sweep-Worktrees.ps1` daily and writes a **report-only** classification to `~/.claude/perf/worktree-report.txt` — it removes nothing. Read the report and remove deliberately.

`scripts/worktree-cleanup.ps1` and `scripts/worktrees.ps1` are thin forwarders — the real implementations live once in `C:\GH\dotfiles\windows\` and take `-RepoPath`, so every repo on the machine shares one copy. This repo's copy had drifted and was the *stale* side, missing dubious-ownership handling, per-worktree try/catch, and the orphan ownership guard. The drift also hid a bug in which a **failed** `git status` was read as a clean working tree, so a worktree holding uncommitted work could classify SAFE and be deleted. To see every repo's worktrees at once, run `C:\GH\dotfiles\windows\Sweep-Worktrees.ps1`.

## Architecture

### Save protocol — the single reliability claim

The whole point of this project: **edits never touch DCS in the hot path.** Every keystroke flows:

1. Component updates local React state immediately.
2. Debounce → push op into IndexedDB outbox (`web/src/sync/outbox.ts`).
3. Drain worker FIFOs each op as `PATCH /api/rows/{kind}/{id}` (or `/verses/...`) with `If-Match: <expected_version>`.
4. **200** removes op, updates local version. **409** surfaces a merge prompt and re-queues. **401** triggers silent JWT refresh — outbox is never cleared on auth failure. **5xx/network** retries with backoff; durable across tab close.
5. Cron Workflow at 05:30 UTC (retimed from 06:00 — see `wrangler.toml`) renders D1 → TSV + USFM and commits to a DCS fork branch (`live-snapshot`). If that fails, edits stay safe in D1; next night catches up.

The fetch client in `web/src/sync/api.ts` is the only thing that talks to `/api/*`. Don't bypass it — its `If-Match` / 409 / 401 handling is what makes the outbox correct.

### Backend (`api/`)

- Cloudflare Workers + Hono router. Entry: `api/src/index.ts`. One Worker serves both `/api/*` and the SPA (bundled into `[assets]` via `wrangler.toml`).
- D1 SQLite stores tn/tq/twl rows, verses (`content_json` = `usfm-js` per-verse object), lexicon, edit_log audit, pipeline jobs, verse_statuses. Migrations in `api/migrations/`.
- R2 (`BLOBS`) stores USFM originals + export snapshots.
- Durable Object `ChapterRoom` (`api/src/chapterRoom.ts`) — per-`{book}/{chapter}` WS presence + change fanout. WS messages are hints; **HTTP + `If-Match` is the source of truth**.
- Workflow `ExportWorkflow` (`api/src/exportWorkflow.ts`) — nightly DCS export, one retryable step per `book × resource`. Triggered by the 06:00 cron in `scheduled()`. Two invariants, both added after a stale-D1 export silently reverted gatewayEdit work on master: (a) **stale or partial D1 must never overwrite master** — the pre-export DCS→D1 sync is batched to stay under Cloudflare's ~1000-subrequest cap (late-alphabet books used to die mid-sync), export has a freshness gate, and a shrink-guard rejects any render that would delete rows; (b) truncated DCS fetches are rejected rather than treated as authoritative. Reimport batches its upserts for the same subrequest-budget reason.
- Second cron `*/5 * * * *` polls non-terminal pipeline_jobs (AI auto-apply needs to fire even when no translator has a tab open). The `scheduled()` handler branches on `controller.cron`.
- Auth (`api/src/auth.ts`): DCS OAuth → our own JWT (TTL decoupled from DCS access token). Dev mode mints via `POST /api/auth/dev` (gated by `DEV_AUTH_ENABLED`); `web/src/App.tsx` silently mints on first load in `import.meta.env.DEV`.
- AI pipeline proxy: `/api/tn-quick` and `/api/pipelines/*` forward to `uw-bt-bot.fly.dev` (override via `TN_QUICK_URL` / `PIPELINE_API_BASE`). Absence of `BT_API_TOKEN` disables those routes.

### Frontend (`web/`)

- React 18 + Vite + MUI v6 + emotion. Vite dev server proxies `/api/*` → `127.0.0.1:8787` (Wrangler).
- Single `Shell` (3-column: Timeline rail · Scripture column · Resource column) with three scripture modes — **rows** (stacked active-verse card), **columns** (parallel doc), **book** (lazy-loaded whole book via IntersectionObserver). Alignment is a separate panel/dialog wrapping a custom HTML5 DnD aligner (NOT `enhanced-word-aligner-rcl`; see `docs/plan.md` for the Vite/Rollup bundler reason); a side-by-side ULT/UST variant lives in `SideBySideAligner.tsx`.
- Hooks: `useChapter` (rows + verses + statuses), `useBook` (summary for nav), `useLexicon` (UHAL + UGL by Strong's), `useCatalogs` (ta / tw type-ahead lists), `useAiDrafts`.
- Routing is hash-based: `#/{book}/{chapter}/{verse}` (see `parseHash` in `App.tsx`). `useBook` is hoisted in `App.tsx` so its chapter cache survives chapter navigation.
- USFM ↔ JSON via `usfm-js`. Word alignment data is part of the per-verse JSON tree; `\zaln-s`/`\zaln-e` round-trip losslessly. `web/src/lib/alignment.ts` and `web/src/lib/replace.ts` handle smart text edits that preserve alignments when word counts line up.
- Hebrew Unicode: UHB stores combining marks in legacy "consonant-dagesh-vowel" order; milestones from ZEC/LAM come out NFC. Every Hebrew↔Hebrew compare must go through `nfc()` from `web/src/lib/hebrew.ts` (see `docs/handoff.md` for measured impact).

### Edit engine (`web/src/lib/replace.ts`) — the alignment-preservation claim

Every inline text edit and find/replace flows through `smartEditVerse` / `smartReplaceVerse`. **The invariant: an edit must never unalign words it didn't touch.** The failure mode is whole-verse flattening — the naive rewrite collapses the verse to one text node, destroying every `\w` and every `\zaln-s` milestone, so the aligner ends up with neither targets to drag nor alignment to reuse. The module avoids this in two tiers: (1) *preserve* — when the change spans full words with matching word counts, rewrite each affected `\w` leaf in place, leaving surrounding/containing milestones untouched; (2) *localized rewrite* — drop only the top-level nodes overlapping the change range, splitting partially-affected milestones into before/after halves so survivors keep their source alignment. Pure insertions and pure deletions flow through the localized path too.

This surface is brittle and has been the source of repeated prod alignment loss. **Every edit-path bug gets a regression case added to `web/src/lib/replace.test.mjs`** (run via `npm --workspace web run test`) — the suite is the real safety net, not types. usfm-js quirks compound here: opening quotes/braces get parked on a marker node's `text` (markers can carry text), and combining-mark order differs between UHB and NFC milestones (compare via `nfc()`).

### Note save semantics

Notes save **only on an explicit Save click** — not on blur, and no longer on
deactivation/unmount (that older behaviour is gone; this section used to describe
it and was stale). Nothing leaves the browser until the user saves.

What keeps that safe is **persistence, not confirmation**: every keystroke is
stashed in the IndexedDB drafts store (`web/src/sync/drafts.ts`), restored on
mount, and surfaced as an "N unsaved" reminder that points back to Save. So an
editor that holds unsaved text must (a) write drafts to that store, (b) rehydrate
from it, and (c) clear the draft once the server confirms. `useUnsavedGuard`
covers reload/tab-close. Don't "fix" a data-loss bug in an editor by adding
save-on-unmount or a confirm dialog — wire it into the drafts store instead.
tW/tA article parts and note templates (`TemplateWorkspace`) were the last two
editors missing this and were wired up in the same way. Both are book-agnostic,
so their `DraftMeta` variants carry no book/chapter/verse — any consumer that
switches on `meta.kind` must special-case them rather than reading `m.book`.

### Concurrency tests (`tests/concurrency/`)

One Playwright worker, no test-level parallelism — every test shares the seeded ZEC fixture and races multiple `browserContext`s *inside* one test (the parallelism is per-test, not across tests). Running tests in parallel would cross the streams.

The `webServer` polls `/api/health` through Vite's proxy so it waits for **both** Vite and Wrangler to be up before tests start.

### Localization — mandatory subagent pass on every UI change

**Any time you create or change UI, you must dispatch a subagent to localize it before you finish.** Not optional, not "if it looks like it needs it." This app ships a UI in 14 languages (`web/src/i18n/locales/*.json`, `en.json` is the source of truth) and we have repeatedly shipped hardcoded English — buttons, tooltips, dialog titles, `aria-label`s, toast/error text, `confirm()` strings, empty-state copy, `placeholder`s. Every one of those is invisible to `typecheck` and to the build.

The pass has **two halves, and the second is not skippable**:

1. **Code pass.** Every user-visible string goes through `t("ns.key")`; add the key to `en.json` **and to all 13 other locale files** (an untranslated locale must not silently fall back — that's how the current ~419-key-per-locale gap accumulated). Then run:

   ```sh
   node scripts/check-i18n.mjs
   ```

   It reports MISSING base keys, missing CLDR plural categories, STALE keys not in `en.json`, and code→`en` ORPHANs (a `t()` key typo renders the raw string — nothing else catches it). It must exit clean.

2. **Browser pass — because the code pass misses things.** Switch the UI language to a non-Latin locale (Arabic is best: it also exercises RTL) and *click through the surface you changed* — open every menu, dialog, tab, popper, error and empty state. Anything still rendering English is a miss. Use the built-in **localization mode** inspect-to-edit overlay (`web/src/components/LocalizationInspector.tsx`, toggled from the Localization tab in Preferences) to hover elements and see which key backs them; text with no match is either hardcoded or an interpolated template (a known gap in the overlay's text-match heuristic — verify those by reading the code). Follow the runbook in **Browser-driven verification** below to get a server and a browser.

Report the result the same way as any other verification: what you clicked, what you found, what you did not check.

### Browser-driven verification

When wrapping up changes that touch frontend behavior — UI, auth flow, save path, history, anything that's only really verified by clicking through the app — drive Chrome yourself via the **Claude-in-Chrome MCP**. Don't hand the smoke test back to the user. `typecheck` and `npm run build` catch types and bundling; they don't catch "the button does nothing." The old handoff doc claim that "vite needs the user" is wrong — `npm run dev` runs cleanly with `Bash run_in_background`.

Run order:
1. `Bash run_in_background: npm run dev` from the **main checkout** (vite watches main's files; either edit main's working tree directly, or pull the branch into main first — e.g. `git -C <main> merge --ff-only origin/<branch>`).
   - **From a worktree instead** (when main's ports are held by a peer, or you'd rather not touch main): the worktree path is fully supported — `scripts/worktree-init.ps1`, then either (a) `npm run build` + `wrangler dev --port <free> --ip 127.0.0.1 --assets "<abs worktree>/web/dist"` from `api/` (one server, SPA+API), or (b) vite from the worktree (it proxies `/api` → a Worker already running on `:8787`, whose seeded D1 is real even if it serves a stub SPA). Never kill a shared server/browser — pin a free port. **Full runbooks: Claude's session-memory notes `reference-worktree-dev-verification` and `reference-preview-mcp-fallback`** (the latter covers the Claude Preview MCP fallback when the chrome-devtools browser is already held).
2. `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/` to confirm both servers are up.
3. `mcp__Claude_in_Chrome__list_connected_browsers` → `select_browser` → `tabs_context_mcp({createIfEmpty: true})` → `navigate` to `http://localhost:5173`.
4. Use `browser_batch` for sequences (click → type → click → screenshot). Reach for `read_console_messages` and `read_network_requests` (URL-filter to `/api/`) on failures. `javascript_tool` is the escape hatch for poking at `localStorage` / `indexedDB` outbox state directly.
5. Stale localStorage state from earlier sessions is a recurring trap — when in doubt, `localStorage.removeItem('bible-editor.auth.token'); location.reload();` to force a fresh sign-in.

### Deploy

> **`npm run deploy` ships to PRODUCTION.** It resolves to `wrangler deploy --env production` (`api/package.json` `deploy` script). Do **not** use it for a dev push — it got us once already. To deploy the **dev** worker (`bible-editor-api-dev`), build the SPA then run a plain `wrangler deploy` (no `--env`) from `api/`:
> ```sh
> npm run build:web                              # from repo root → web/dist
> cd api && npx wrangler deploy                  # NO --env → dev worker bible-editor-api-dev
> ```
> Same rule for D1: a plain `--remote` migration targets the **dev** databases (`bible_editor_dev`, `bible_editor_mltest_dev`); prod requires `--env production`. So `--remote` without `--env production` is the safe dev target.
>
> **Non-interactive gotcha:** two Cloudflare accounts are authed on this box, so `wrangler deploy` / `d1 ... --remote` fail with *"More than one account available… non-interactive mode"*. Export `CLOUDFLARE_ACCOUNT_ID=5a3ffd86280d3ed086be76d955829242` (unfoldingWord — where all three DBs `bible_editor`, `bible_editor_dev`, `bible_editor_mltest_dev` and the workers live) for the command. Only prod `bible_editor` is targeted by name+`--env production`, so dev commands that name the `_dev` DBs never touch it.

Single command from repo root: `npm run deploy` builds `web/dist` then runs `wrangler deploy --env production` from `api/`. The Worker serves both `/api/*` and the SPA. See [`docs/deploy.md`](docs/deploy.md) for first-time provisioning (D1 create, R2 bucket, secrets `JWT_SIGNING_KEY` / `DCS_CLIENT_ID` / `DCS_CLIENT_SECRET` / `DCS_SERVICE_TOKEN` / `BT_API_TOKEN`).

Prod-only vars (`ALLOWED_ORIGINS`, `DEV_AUTH_ENABLED=false`) live in `[env.production.vars]` so the default env stays dev-friendly. Don't put prod values at the top level — that broke local dev once already.
