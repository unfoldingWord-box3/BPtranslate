# Loop state · bible-editor

> The agent forgets; this file does not. It holds what this project **is** — what's blocked
> on a human, the durable lessons that aren't in the code, and the standing goals.
>
> **This file must not contain a session log.** No "Last run", no "Completed", no
> "In progress". Those sections were removed on 2026-07-20: every parallel worktree wrote
> them at the same anchor line, so git got N blocks claiming one position and the file
> conflicted on essentially every merge (the log had reached ~1,780 of 1,866 lines).
> What just happened belongs in **the commit message and the PR description** — written
> once, per branch, and structurally incapable of conflicting.
>
> - **In-flight status goes in `.claude/state/<worktree-name>.md`** — one small file per
>   worktree, deleted when its PR merges. Separate files never collide.
> - **Never commit a STATE.md-only change to main.** A note *about* a PR belongs in that
>   PR's thread; a code-free commit to a shared file makes every open branch stale.
> - A conflict that *does* survive here is now meaningful: two sessions learned
>   contradictory things, and that's worth stopping for.
>
> Pair it with the standing spec: [`CLAUDE.md`](CLAUDE.md) (how to work here) and
> [`docs/plan.md`](docs/plan.md) / [`docs/handoff.md`](docs/handoff.md) (where the project is going).
> Deliberately-postponed work lives in [`docs/deferred.md`](docs/deferred.md), not here.

## Escalated / blocked on a human (not a code change Claude can land alone)

- **Apply migration `0072_export_snapshot_chapters.sql`** — local (`bible_editor_dev --local`);
  prod picks it up via `npm run deploy` (which runs `db:migrate:remote` first) and the dev worker via
  the deploy-dev workflow. Adds nullable `chapters` to `export_snapshots` for chapter-scoped Door43
  exports. Until applied, `GET /api/exports` errors (it selects the column). (DEV fork only; never
  `--env production` here.)
- **Apply migration `0062_book_source_kind.sql`** — local (`bible_editor_dev --local`)
  and, when the Aquifer-per-range PR lands, prod. Adds `kind TEXT NOT NULL DEFAULT
  'dcs'` to `book_source_overrides` for the issue #103 follow-up (Aquifer as a
  per-chapter-range tN source). Existing rows default to `'dcs'` (no behavior
  change). The feature is inert until applied. (DEV fork only; never
  `--env production` here.)
- **Apply migration `0043_pipeline_job_source_generation.sql`** — local (`bible_editor_dev --local`) and prod (`bible_editor --remote --env production`) before relying on pipeline source stamps or `staging` book-status CAS. Code landed on `feat/scripture-repo-preferences`; D1 not applied this session.
- **Apply migration `0059_scripture_lane_carry_forward.sql`** — local (`bible_editor_dev --local`) and, when PR-2 lands, prod. Adds `mode` + `carried_forward` to `scripture_lane_replacement_books` for issue #94 carry-forward. PR-1 code (`copyBookForward` in `scriptureLane.ts`) is DORMANT — nothing calls it yet — so applying is only strictly needed before PR-2 wires startReplacement/routes/UI. (DEV fork only; never `--env production` here.)
- **Prod `DEU 27:22` TN content-dup** — 2 live PRISTINE notes, same content (occ 1, quote `שֹׁכֵב֙ עִם`,
  note "See how you translated 'lies with'…") under ids `y3oq` + `oi0y` (both valid ids — a pure
  doubling, not a digit-first id). The new reimport Guard 2 PREVENTS new doubles but does NOT remediate
  this existing pair (it's insert-time only). Remediate by soft-deleting one copy (`scripts/dedup-tn.mjs`
  or the prod verse-repair pattern: version+1 + edit_log). Found 2026-06-18 via a corpus-wide live
  pristine content-key scan (only 1 such group corpus-wide). (memory: tn-ai-duplication-roundtrip)
- **en_ust master `PSA 24:6` UST** — unclosed `\qs` Selah still malformed on master; D1 already healed (v2).
  Needs the `-be-` export branch merged to land the fix. (memory: selah-qs-malformation-psa246)
- **Prod `MIC 5:5`** — bracket/period-marker engine bugs fixed in code, but the already-stored verse
  still needs re-alignment / re-import. (memory: mic-bracket-and-period-marker-bugs)
- **AI TN doubling, master `ISA 10:29`** — remediate doubled notes via `scripts/dedup-tn.mjs`;
  D1 copy `ISA 29:30` also affected. Root fix shipped; existing rows still need the cleanup pass.
  (memory: tn-ai-duplication-roundtrip)
- **Dangling `-be-` export refs** — `DCS_SERVICE_TOKEN` can't delete branches; drifted branches must be
  cleared by hand with a maintainer PAT. (memory: export-service-token-no-delete, export-branch-no-rebase-drift)
- **English ULT/UST under Arabic lanes after a translate-intent import** (BSOJ `LUK`, reported 2026-09-12
  from `#/notes/LUK/1`). Verified on the dev workspace (`bible_editor_dev`, workspace `bsoj`): LUK was
  imported 2026-09-10 with `translateFromSource`, `book_imports.ult_source/ust_source` read
  `source:unfoldingWord/en_ult|en_ust`, both lanes unlocked (`textReadOnly:false`), and BSOJ/ar_avd +
  ar_nav DO carry `43-LUK.usfm` on master — so the eager swap, not a missing file, loaded the English.
  Dev was repaired 2026-09-12 (columns cleared, `POST /api/books/LUK/reimport` ult+ust re-pulled all
  pristine rows from the lane repos). **Still open for a human:** the same check on any other BSOJ
  deployment this fork does not touch, and any book imported with the translate intent after 2026-07-31
  (`c741f89`). Repair recipe: clear the two columns for the book, then Re-pull ULT+UST; rows a human
  already edited on the English text come back as `skipped_edited` and need a forced overwrite.

## Lessons learned (write durable, cross-session facts here — not in chat)

For the full corpus, see the memory index at
`C:\Users\benja\.claude\projects\C--Users-benja-Documents-GitHub-bible-editor\memory\MEMORY.md`.
Highlights that bite repeatedly:

- **The chat MCP endpoint (`POST /api/mcp`, `api/src/mcp.ts`) is one server for every workspace, and the
  account link picks the workspace** (#676). BT Servant pools every registered server's tools for every
  org, so per-workspace servers would put duplicate `bpt_*` tool sets in front of the bot. The bearer is one
  secret (`MCP_SERVICE_TOKEN`, 32+ chars). Every tool but `bpt_link_account` requires the `session_token`;
  the `chat_links` row names the workspace the code was issued in (`api/src/chatLinks.ts`, #669), and a link
  whose workspace is gone counts as not linked, never the `list[0]` fallback the cookie path uses. It is
  handled in the `index.ts` fetch wrapper before the cookie swap and before every Hono middleware. Tools read
  through the same route handlers in-process (`app.fetch`) on that workspace's env, so they see what the web
  app sees. Two exceptions (#671): `session.packageRefs` (`api/src/packageRefs.ts`) reads D1 directly for
  `bpt_package_status`'s tW/tA/template counts, because the article and template routes are editor-only and
  the in-process call carries no user (SELECTs only, counts only, never text); and `session.sourceNotes`
  (`api/src/sourceNotes.ts`) fetches the English tN TSV for the `en_note` of `bpt_chunk_work` and `bpt_get_row` from Door43
  anonymously, the same data the web app's browser fetch shows (never with the DCS service token). Links: one-time code from the web app (any signed-in user, viewers included), 30-day token,
  hash-only storage, role re-read from the link's workspace on every call and capped at editor. Reads go
  through `readerFrom()` and write tools must call `principalFrom()` (editor only) in `mcpTools.ts`; never
  accept a workspace, username or user id as a tool argument.
- **Local alignment testing needs the `mltest` workspace, not the default.** `POST /api/auth/dev`
  with no `be_ws` cookie lands on `bsoj` (the first entry in `WORKSPACES`). Its `ar-bsoj` preset
  quarantines the ULT/UST lanes as soon as verses exist (`ensureLaneState` in
  `api/src/scriptureLane.ts`), so the aligner says "Alignment is locked" and a local UPDATE to
  `scripture_lane_state` is rewritten on the next config read. Instead, apply migrations and seed
  `bptranslate_mltest_dev --local`, then send the cookie `be_ws=mltest` (Playwright:
  `ctx.addCookies` before the dev-auth POST). That lane comes up with `alignmentWritable: true`.
  Playwright's `locator.dragTo` drives the aligner's HTML5 drag and drop; cards are
  `[data-group-id]` and chips are `[draggable="true"]` (#594 part 2).

- **A Workflows step error reaches `run()`'s catch as `${name}: ${message}`, not as the object you
  threw.** The engine runs a step across an isolate boundary and rebuilds its error on the far side,
  so `new NonRetryableError("[merge_failed] …")` arrives with message
  `"NonRetryableError: [merge_failed] …"`. Any convention that reads structure out of a step error's
  message has to allow for that prefix: the translate runner's `[kind] ` tag did not, so every
  failure its catch-all recorded was filed as a retryable `internal_error` instead of its real kind
  (fixed by `ENGINE_NAME_PREFIX` in `api/src/translate/workflowSteps.ts`). **Only a real engine shows
  this** — a hand-rolled `step` double hands the thrown object straight back, which is exactly why the
  claim survived source review. Measured with the miniflare Workflows harness
  (`api/src/translate/workflowHarness.mjs`), which can host any WorkflowEntrypoint in this repo.

- **Marker chips are TEXT, and `smartEditVerse` rebuilds the verse's whole marker layout from the captured text
  alone — so a capture that loses the chips silently deletes every `\q` in the verse.** `reconcileMarkers`
  (`web/src/lib/replace.ts`) unconditionally drops every inert in-flow marker and re-inserts only the ones it
  finds in `newPlain`. When the chips are missing, every word still round-trips, so alignment survives intact and
  `preservedAlignment` stays **true** — neither the collateral-loss guard nor the unaligned-words toast fires —
  and the nightly export carries the loss to master. Upstream #606: HOS ULT 11:9/11/12 lost all 11 of their `\q`
  markers this way and it sat live on Door43 for a fortnight. The engine now guards it
  (`markerCaptureLooksDropped`, ported from upstream `37f40985`), but the guard only covers an edit where **no
  word changed** and only DOM captures (`capturedFromDom`). **Lesson for any future marker-loss report: check
  whether the captured text still had its chips before suspecting the diff tiers.**

- **`user_roles` is prod's live access gate, and migrations can't skip prod.** `callbackDcsAuth`
  checks `user_roles` *before* upserting into `users`, so deleting a row revokes that account's
  ability to mint a JWT and write. Production does **not** yet have the Door43 org-roles
  adjustment that supersedes this allowlist, so the 10 editors seeded by `0016` must stay in
  `bible_editor` until org-roles lands there. Anything that changes `user_roles` membership
  therefore belongs in a hand-applied script (`scripts/prune-seeded-editors.sql`), never a
  migration — the migration set runs against every D1 in the project, including prod, so there
  is no honest "dev-only migration". Corollary: **never seed accounts in a migration**; `0016`'s
  seed block landed in every new per-org database (`bible_editor_mltest_dev` etc.), giving each
  fresh org 11 allowlisted accounts it never asked for. It now seeds only the admin.

- **Stopping a `wrangler dev` background task can orphan `workerd.exe` still bound to the port.**
  A restart then leaves *two* listeners on the same port and requests are served
  nondeterministically by the stale one — which presents as newly added routes returning 404
  (`{"error":"not_found"}`) while older routes work, and survives clearing `.wrangler/tmp`.
  Diagnose with `netstat -ano | grep ":<port> " | grep LISTENING` and look for **more than one
  PID**; fix with `taskkill //PID <pid> //F` and restart on a fresh port. Same failure shape as
  the cross-worktree port-collision trap, but self-inflicted by stop/restart.
- **`scripts/import-articles.mjs` output cannot be applied to a local D1 as generated.** Its
  `BATCH = 50` produces INSERT statements that exceed wrangler's local per-statement limit, so
  `wrangler d1 execute ... --local --file=../scripts/out/import-articles.sql` dies with
  `statement too long: SQLITE_TOOBIG` — and the failure is easy to miss because the applier still
  prints a normal-looking tail, leaving `article_units` silently at 0. Workaround for local dev:
  run the importer with `BATCH` lowered (3 works) and apply that file. The `--remote` path is
  unaffected, which is why this survived unnoticed.
- **This API is cookie-auth only** — the HTTP `Authorization: Bearer` fallback was removed (see
  the comment above the WS route in `api/src/index.ts`). Manual curl testing needs a cookie jar
  (`curl -c`/`-b`) seeded via `POST /api/auth/dev`, plus an `x-csrf-token` header (read from the
  `be_csrf` cookie) for any mutating request. A Bearer token silently yields *unauthenticated*
  requests, not a 401 you can spot.
- **Workspace roster is DB-backed as of PR-1 of #81, with a strict fail-soft chain.** `workspaces.ts`
  reads the roster from the `workspaces` registry table on the SHARED DB (migration 0058), loaded once
  per isolate by the async `primeWorkspaces(env)` that the entry points (`index.ts` fetch/scheduled,
  `exportWorkflow.ts`) await before the *synchronous* `resolveWorkspace`/`listWorkspaces`. Ordering is
  **registry → WORKSPACES env var → implicit default** and MUST never throw. Two traps that shaped it:
  (a) seed the table from the env var only, **never the implicit default** — seeding a `{slug:default}`
  row would freeze `VIEWER_ORG` (which the implicit default reads dynamically); (b) D1 returns NULL for
  absent `export_owner`, and `parseEntry` rejects a non-string/non-undefined `exportOwner`, so map
  NULL→undefined before validating. Only `status='claimed'` rows are listable; the other statuses
  (available/provisioning/failed/retired) are spare-pool lifecycle bookkeeping for later PRs.
- **RTL scripture font choice is provisional.** As of the RTL-display fix (branch
  `claude/rtl-language-display-bee8f4`), non-original RTL panes (e.g. Arabic AVD/NAV) render in the
  normal reading stack `"Source Serif Pro","Cambria","Times New Roman",serif` at the standard reading
  size — deliberately NOT the Hebrew original's enlarged SBL-Hebrew treatment (that stays keyed to
  `bibleVersion === "UHB"` alone). Source Serif Pro lacks Arabic glyphs, so Arabic falls back to
  Cambria/Times, which do cover it. **If native Arabic (or other RTL) speakers find the rendering
  ugly/unreadable, switch to an SIL font with real Arabic coverage** (e.g. Lateef, Scheherazade New,
  Harmattan) — bundle it and prepend it to the non-Hebrew branch of the font stacks in
  `web/src/components/{DocColumn,BookView,ScriptureColumn}.tsx` (the `hebrewSource ? SBL : reading`
  ternaries). Direction/alignment are already correct and language-driven (`versionIsRtl` in
  `web/src/lib/versionLabels.ts`); this is purely a glyph-quality follow-up.
- **A synthetic fallback identity for translatable content is a data-loss trap, not a kindness.**
  The note-template sync (`api/src/templateSync.ts`) originally invented a positional id
  (`<supportRef>-p<n>`) when the source sheet had no id column. Those rows are translatable, so the
  moment real ids appeared every one of them would soft-delete and re-insert blank, orphaning any
  translation done in between. Writing *nothing* until identity is trustworthy is strictly safer —
  the sync now aborts with a warning instead. Generalize: when identity is the thing you're missing,
  don't guess it; refuse to write.
- **Fresh worktree:** run `scripts/worktree-init.ps1` to junction `node_modules` from main —
  never reflexively `npm install` on a branch (it leaks deps into main). Only `npm install` in MAIN.
- **Don't kill shared dev servers.** Multiple worktrees share Chrome MCP + dev ports (5173/5174/8787).
  Pick a free port or ask; never `taskkill` a port owner. `5173` is svchost-reserved on this box — relocate vite.
- **Migrations collide across parallel worktrees.** Check `wrangler d1 migrations list --remote` after any
  schema PR; a collided migration number left prod unmigrated → list-route 500s once already.
- **PR already merged?** Before pushing, run `gh pr view --json state,mergedAt`. If merged, rebase onto main,
  branch fresh, open a new PR — do not push to the merged branch. This happens regularly.
- **Hebrew compares must go through `nfc()`** (`web/src/lib/hebrew.ts`) — UHB stores combining marks in legacy
  order; milestones come out NFC. Skipping this silently breaks alignment matching.
- **`usfm-js` parks leading punctuation/markers on the node's `text`** — markers can carry text; opening
  quotes after a marker live on the marker node, not as a sibling.
- **Export USFM puts punctuation outside `\w` (`\w earth\w*.`) on purpose** — correct uW form, not churn; don't "fix" it.
- **An env-clone helper that swaps bindings by name must resolve those bindings from the original env**, or it silently
  returns the currently-active one when re-applied (`workspaceEnv` in `api/src/workspaces.ts` bit this — fixed by always
  reading off a `BASE_ENV` reference). More generally: **per-org identity cached in a token (e.g. a `role` claim) has to
  be re-resolved when the org changes, not just at sign-in** — a workspace/org switch that only swaps the active database
  while leaving a stale claim in the session token is a privilege-escalation seam, not a cosmetic bug.
  Since #680 the access JWT carries a `ws` claim and `attachAuth` treats a token whose `ws` differs from the
  request's resolved workspace (or is missing) as signed out, so the client's 401 refresh re-derives the role.
  Every `mintToken` call must name the workspace the role was resolved in, and a test that signs a JWT by hand
  must include `ws` equal to its env's `WORKSPACE_SLUG` (`"default"` when unset) or every request 401s.
- **`node:sqlite` (`DatabaseSync`) works for D1 schema/trigger testing.** Node 24's built-in SQLite supports `unixepoch()`,
  `?1`/`?2` positional params, triggers with `RAISE(ABORT)`, and CHECK constraints. Use an in-memory DB + the migration
  CREATE TABLE/TRIGGER statements to unit-test schema invariants without Miniflare. Wrap multi-statement batches in
  `BEGIN`/`COMMIT` with try/catch `ROLLBACK` to match D1 batch atomicity (SQLite's `RAISE(ABORT)` only rolls back
  the current statement, not the whole transaction).
- **Any new module-level cache in `api/src` must be workspace-keyed.** With per-org workspaces
  (`worktree-feat-org-workspaces`), a cache keyed only by e.g. `"project-config"` is shared across every org
  because it lives at the Worker *isolate* level, not per-request. `getProjectConfig`'s 60s cache (and
  `catalogs`/`twlFilters`/`twlSuggest`) leaked another org's config — including `org`/`exportOrg` — after a
  switch until keyed by `WORKSPACE_SLUG`.
- **Cloudflare Workflows do not inherit the per-request env clone** — they read the raw Worker `env` via
  `this.env`, not whatever `workspaceEnv()` swapped in for the triggering request. `ExportWorkflow` rendering
  the wrong org's D1 into the wrong org's DCS repos (plus colliding `nightly-${day}` instance ids masking a
  second org's export entirely) was only caught by actually running two workspaces side by side. Same caution
  applies to anything else handed to a Workflow/Queue/alarm rather than a request closure — re-point `this.env`
  explicitly from params at the top of the handler.

- **The deployed dev worker is public — its config is deliberately hardened, don't undo it.**
  `SUPER_ADMINS` is empty in wrangler.toml's default env (local dev sets `SUPER_ADMINS=dev` in
  `api/.dev.vars` instead, which never deploys — existing checkouts/worktrees must add that line
  or workspace switching to mltest and the `/api/workspaces/pool` routes silently 403 locally);
  `DCS_SERVICE_TOKEN` **is** set on the dev worker since 2026-10-30 (#714, a `BibleEditorService`
  token with `write:repository`): context exports publish the pack to Door43, which is what lets
  an approved template reach AI drafts (#707). Before that it was deliberately absent so dev
  exports failed closed as `no_service_token`; the trade accepted is that a manual export from
  the public dev app now writes real Door43 repos (`DCS_EXPORT_OWNER` is the same in both envs;
  the dev worker still has no crons). Known consequence of the empty `SUPER_ADMINS`: the pool routes are
  super-admin-only, so on the *deployed* dev worker they 403 for everyone — pool flows are
  local-dev-only until that's revisited (#81/#182). One accepted risk, decided 2026-08-17
  (PR #180 review, issue #182): `ALLOWED_ORIGINS=""` on the dev worker falls back to localhost
  credentialed CORS — accepted because the SPA is same-origin and the double-submit CSRF check
  limits it, and splitting the var would complicate local dev.

## Stop conditions / goals

- No standing automated loop is wired to this file yet. When one is, record its goal here, e.g.:
  - `/goal "npm run typecheck && npm run build clean"` — met on `<commit>` at `<time>`.
