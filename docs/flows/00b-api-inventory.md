# 00b — API Inventory (bible-editor backend)

Authoritative inventory of every HTTP endpoint and realtime channel in `api/src`, built so a new UI can be checked against it for gaps. Compiled by reading the Hono router source directly (not by grepping for path strings alone) — every route below was confirmed against its handler code, not inferred from a mount line.

**Method:** five parallel agents each read a disjoint set of `api/src/*.ts` files end to end, distinguishing actual `app.get/post/put/patch/delete` registrations from pure library files (helpers with no Hono instance, consumed by a route file elsewhere). Findings were merged below without re-verification of every citation — treat file:line citations as agent-reported, not independently re-checked by the merge step. Anything genuinely uncertain is marked `[INFERRED]` inline, carried over from the source agent.

**Bundle legend:** A = org setup · B = book import · C = preferences/context-pack export · D = AI bulk pipelines · E/F = notes-questions row editing + approve · G = verse/scripture editing · H = alignment (part of verse content) · I = templates · J = tW/tA articles · K = observability (health, job status, presence) · AUTH = login/session · INFRA = infra/health/error-handling.

**Totals:** 110 HTTP endpoints + 1 WebSocket upgrade route + the ChapterRoom DO's internal `/broadcast` route (server-to-DO only, not client-reachable) + 3 cron branches (1 dormant, unregistered in `wrangler.toml`).

---

## AUTH / INFRA / WebSocket

Files read in full: `api/src/index.ts`, `api/src/auth.ts`, `api/src/chapterRoom.ts`, `api/src/wsEvents.ts`, `api/src/alerts.ts`.

### Health / top-level infra

**GET `/api/health`** — `index.ts:218-224`
Auth: none. Response: `200 { ok:true, service:"bible-editor-api", time }`. No side effects. Bundle INFRA.

**`/api/*` 404 fallthrough** (`app.notFound`, `index.ts:315-322`) — non-`/api` paths fall through to the SPA `ASSETS` binding; `/api/*` misses get `404 { error:"not_found", path }`. Not a client-called endpoint, listed for completeness only.

**Global error handler** (`app.onError`, `index.ts:207-216`) — unhandled throw → `500 { error:"internal_error" }`; `HTTPException` passes through its own response. Not a route.

**GET `/api/ws/chapter/:book/:chapter`** — `index.ts:292-309`. Auth: inline `currentUserId(c)===null → 401` (reads `be_access` cookie via the global `attachAuth`). Request must be a WS `Upgrade` (else `426`); `:chapter` must parse as a finite int (else `400`). Forwards the raw request into the `ChapterRoom` Durable Object named `${workspaceSlug}:${BOOK}:${chapter}` — rooms are workspace-scoped. Bundle K.

### Middleware gating every request below
- CORS: strict `ALLOWED_ORIGINS` allowlist (dev defaults to localhost/127.0.0.1), `credentials:true` — `index.ts:149-161`.
- `attachAuth` — stamps `userId/username/role` from the `be_access` JWT cookie if valid; never itself rejects — `index.ts:163`, `auth.ts:310-325`.
- `requireWorkspaceMatch` — workspace cookie/env consistency guard — `index.ts:164`.
- `requireCsrf` — non-GET/HEAD/OPTIONS requests need `X-CSRF-Token` header matching the `be_csrf` cookie, else `403 { error:"csrf_mismatch" }`. Exempt: `/api/auth/dcs/start`, `/api/auth/dcs/callback`, `/api/auth/refresh`, `/api/auth/logout`, `/api/auth/dev` — `index.ts:165`, `auth.ts:338-360`.
- `blockViewerWrites` on `/api/*` — 403s viewer-role mutations outside a small self-scoped allowlist — `index.ts:172`.
- Response header hardening (CSP/Referrer-Policy/X-Content-Type-Options) — `index.ts:186-200`.

### AUTH routes (`api/src/auth.ts`)

| Route | Auth | Notes |
|---|---|---|
| GET `/api/auth/dcs/start` | none | `302` to DCS OAuth authorize URL; sets `dcs_auth_state` cookie (HttpOnly, 10min). `503 dcs_not_configured` if no `DCS_CLIENT_ID`. `index.ts:228`; `auth.ts:572-594`. |
| GET `/api/auth/dcs/callback` | none (CSRF-exempt) | OAuth completion: exchanges code, fetches DCS profile, resolves login workspace, syncs Door43 team role, upserts shared+per-workspace `users`, seeds `project_config` on first admin login, mints JWT+session+CSRF+`be_ws` cookies, `302` redirect (`/`, `/?_choose_ws=1`, or `/?_auth_denied=1&u=`). `index.ts:229`; `auth.ts:597-840`. |
| GET `/api/auth/me` | inline (`401` if no `userId`) | `200 { userId, username, role, lastBook/Chapter/Verse, workspace, workspaceIsFallback }`. `index.ts:230`; `auth.ts:845-872`. |
| POST `/api/auth/refresh` | none (cookie-driven, CSRF-exempt) | Rotates `be_access` from `be_refresh`; re-checks allowlist + throttled Door43 team resync; `401` invalid/expired session, `403 forbidden/not_an_editor` if no role resolves. `index.ts:231`; `auth.ts:879-928`. |
| POST `/api/auth/logout` | none (CSRF-exempt) | Revokes session row, best-effort DCS token revoke, clears all session cookies — deliberately not gated by `requireAuth` so an expired cookie can still be cleared. `index.ts:235`; `auth.ts:1013-1064`. |
| PUT `/api/users/me/location` | requireAuth | Body `{book, chapter, verse}` (validated); `UPDATE users SET last_book/chapter/verse`. `index.ts:236`; `auth.ts:1072-1098`. |
| POST `/api/auth/dev` | **dev-only**: `DEV_AUTH_ENABLED==="true"` AND request hostname is `localhost`/`127.0.0.1` (else `404` either way) | Auto-grants `admin` role on first use, mints synthetic user + JWT/session/CSRF. The localhost check is a second, independent gate on top of the env flag — protects the public `*.workers.dev` dev worker. `index.ts:244-260`; `auth.ts:937-998`. |

Bundle: all AUTH.

### `api/src/alerts.ts` (mounted `/api/alerts`, bundle K)

- **GET `/api/alerts/me`** — requireAuth; `200 { alerts:[{id,severity,message,linkUrl,createdAt}] }` from `system_alerts` for the caller's username, `dismissed_at IS NULL`. No POST/create route in this file — rows are written by the post-export validator [per file-header comment, not independently verified]. `alerts.ts:24-43`.
- **POST `/api/alerts/:id/dismiss`** — requireAuth only (viewer-allowed, self-scoped); `200 { ok, changed }`; `UPDATE system_alerts SET dismissed_at=... WHERE id=? AND username=?`. `alerts.ts:50-66`.

### ChapterRoom Durable Object — WebSocket protocol (`api/src/chapterRoom.ts`, `wsEvents.ts`)

One DO instance per `{workspaceSlug}:{book}:{chapter}`. In-memory `Set<WebSocket>` only — **no persistent state**, resets if the DO evicts. Capped `MAX_CLIENTS_PER_ROOM=100` (`503 "room full"` beyond that) — `chapterRoom.ts:18,60-62`.

**Internal, non-WS route:** `POST /broadcast` (server-to-DO only, called from `wsEvents.ts`'s `broadcastChapter()`/`broadcastLaneEvent()` — never reachable from a browser). Body is a `WsEvent`; fanned out verbatim to every open socket. `chapterRoom.ts:34-52`.

**Client→Server:** `{type:"ping"}` every 20s — liveness only, no state. `chapterRoom.ts:82-90`.

**Server→Client:**
| Type | Hint vs authoritative | Fields |
|---|---|---|
| `pong` | hint (ping reply) | — |
| `row.upserted` | hint — client dedupes by `version`; HTTP+If-Match remains authoritative | `kind, row` |
| `row.deleted` | hint | `kind, id, version` |
| `verse.updated` | hint | `verse: VerseDto` |
| `verse_status.updated` | hint | `status` |
| `lane_check.updated` | hint — carries full `checkers[]` so client recomputes shading | `check` |
| `lane_check.bulk` | hint — coalesced whole-lane update, avoids fanout storm | `book, chapter, lane, checks[]` |
| `chapter.pipeline_applied` | hint — tells open tabs an AI pipeline wrote rows outside HTTP; client prompts save+refresh, does not silently refetch | `book, chapter, pipeline_type` |
| `lane.replacement_freeze` | hint that gates client behavior; the actual freeze is server-side (HTTP) | `lane, jobId, predecessorGeneration, activeGeneration, configRevision, status` |
| `lane.replacement_settled` | hint — tabs refetch config+chapter | same shape |

**Every message, both directions, is a hint — never authoritative.** Repeated in code comments (`chapterRoom.ts:6-9`, `index.ts:288-291`). All mutation flows through HTTP PATCH with `If-Match`.

**Presence:** the DO tracks *connection* presence (`this.clients: Set<WebSocket>`, add on `accept()`, remove on close/error) but **no user identity is attached** and **no roster is ever broadcast** — despite the module comment claiming "no presence," there is in fact a live connection count, just never surfaced to clients. [INFERRED from absence: no roster message type exists in the `WsEvent` union, so a "who else is viewing this chapter" feature does not exist today and would be net-new.]

**Auth on the socket:** validated once at upgrade (`401` if no `userId`); **never re-validated** for the socket's life (`chapterRoom.ts:64-75`, explicit "ACCEPTED TRADEOFF" comment) — an expired JWT does not close an open socket, since the socket carries no write authority.

The scheduled cron handlers (`runScheduledTick`) are not HTTP/WS surfaces and are documented separately under Bundle C below (they matter for UI-visible *state*, not as endpoints).

---

## Bundle A — Org Setup, Workspaces, Admin

Mounts: `/api/orgs` (`orgRoutes.ts`), `/api/workspaces` (`workspaceRoutes.ts`), `/api/admin/users` (`adminUserRoutes.ts`) — `index.ts:277-279`. `orgInference.ts`, `workspaces.ts`, `dcsTeams.ts` are pure libraries (confirmed by full read) consumed by these three route files — no additional routes.

### `orgRoutes.ts` — all routes `requireAuth + requireAdmin` (file-level `use("*")`, `orgRoutes.ts:23`)

- **GET `/api/orgs/search?q=`** — `200` always (degrades to `{matches:[]}` on empty/no-match); one DCS call `GET /api/v1/orgs/{q}`. DCS 1.26 has no fuzzy search, so 0-or-1 match only [per code comment]. `orgRoutes.ts:42`.
- **GET `/api/orgs/verify-source?url=&checkBooks=`** — parses a pasted Door43 URL; `400` bad url, `503 dcs_unavailable` (network/5xx/429, never reported as false-404), `404 repo_not_found`, `200 {ok:true, org, repo, fullName, hasBooks?}`. `orgRoutes.ts:76`.
- **GET `/api/orgs/:org/inferred-config`** — draft-only inference (nothing applied — admin must separately `PUT /api/project-config`); `400 invalid_org`, `404 org_not_found`/`403 dcs_forbidden`/`502`, `422 no_tn_repo`, `200 {org, proposal, missing, ambiguous, manifestFound, warnings}`. Up to 20 parallel manifest fetches. `orgRoutes.ts:114`.

### `workspaceRoutes.ts` — file-level `requireAuth`; several routes add ad-hoc super-admin/membership checks (no shared super-admin middleware exists)

- **GET `/api/workspaces`** — any signed-in user; `200 {current, workspaces[...]}`, `membershipUnknown:true` when org membership can't be confirmed. Super admins see every workspace; others see only confirmed-member/allowlisted/currently-active. `workspaceRoutes.ts:79`.
- **GET `/api/workspaces/pool`** — super-admin only (inline `superAdminUser` check, distinct from `requireAdmin`); `403` otherwise; `200` = `PoolStatus`. `workspaceRoutes.ts:168`.
- **POST `/api/workspaces/pool`** — super-admin only; registers a pre-provisioned D1 binding as claimable (`400 binding_required`, `409 slug_taken/binding_taken`, `201 {ok,slot}`). `workspaceRoutes.ts:175`.
- **POST `/api/workspaces/pool/claim`** — super-admin only; flips an `available` slot to `claimed` for an org (`503 pool_exhausted`, `200/201 {ok, slug, org, alreadyClaimed}`, idempotent). `workspaceRoutes.ts:193`.
- **POST `/api/workspaces/:slug`** — requireAuth + (super-admin OR target-workspace `user_roles` row OR confirmed DCS org member), else `403 workspace_forbidden`. The actual switch action: sets `be_ws` cookie, mirrors user into target workspace, best-effort DCS team resync, re-mints Access JWT scoped to the new workspace, seeds `project_config` if absent, updates `last_workspace_slug`. `workspaceRoutes.ts:217`.

### `adminUserRoutes.ts` — file-level `requireAuth + requireAdmin`

- **GET `/api/admin/users`** — `200 {users:[{username,role,addedAt,addedBy,source}]}` (admins first, alpha). `adminUserRoutes.ts:66`.
- **GET `/api/admin/users/org-members`** — always `200` (fails soft through 3 fallback tiers: admin's own DCS token → shared `DCS_SERVICE_TOKEN` → unauthenticated `public_members`); never writes `user_roles` — read-only reconciliation view. `adminUserRoutes.ts:251`.
- **POST `/api/admin/users/purge-manual`** — bulk-resets manual role grants back to DCS-team-derived state; always preserves at least one admin. `adminUserRoutes.ts:332`.
- **PUT `/api/admin/users/:username`** — body `{role:"admin"|"editor"}`; `404 dcs_user_not_found`, `409 last_admin` (atomic guard in the UPSERT's WHERE clause), `200` with `wasTeamManaged`/`dcsVerified` flags. `adminUserRoutes.ts:395`.
- **DELETE `/api/admin/users/:username`** — `409 last_admin`, `404 not_found`, `200 {ok, wasTeamDerived}`. `adminUserRoutes.ts:522`.

---

## Bundle B — Book Import

Mounts: `/api/books` (`bookImport.ts`), `/api/pending-imports` (`pendingImports.ts`) — `index.ts:226,274`. Pure-library supporting files (no routes, confirmed): `bookReimport.ts`, `bookSource.ts`, `reimportClassify.ts`, `aquiferConvert.ts`, `aquiferSources.ts`, `dcsSources.ts`, `rawUrlPin.ts`, `repoUrl.ts`. `aquiferImport.ts` exports a handler function wired in by `bookImport.ts`, not its own Hono app.

- **GET `/api/books`** — no auth; `200 {books:[{book, imported_at}]}`. `bookImport.ts:86`.
- **GET `/api/books/:book/lint`** — requireAuth; `200 {book, total, flagCount, escalateCount, issues[]}` (read-only across tn/ult/ust). `bookImport.ts:97`.
- **POST `/api/books/:book/aquifer-drafts`** — requireAdmin; merges Aquifer notes as unapproved drafts, **never** overwrites `validated`/`edited` rows. `409 book_not_imported`/`import_in_progress`, `502` on Aquifer/EN-tN fetch failure, `200 {ok, approved, inserted, replaced, skippedApproved, report}`. Writes `tn_rows`, `edit_log`, stamps `book_imports.tn_source`. `bookImport.ts:130` → `aquiferImport.ts:82`.
- **POST `/api/books/:book/aquifer-repair`** — requireAdmin; rewrites the markdown formatting of notes already imported from Aquifer (stray `****` runs, swallowed spaces), for the approved/edited rows the import itself protects. Only rows whose text still matches the pre-fix render byte for byte are touched; anything a human changed is reported as `humanEdited`. `?dryRun=1` reports without writing. `200 {ok, applied, aquiferRows, repaired, alreadyClean, humanEdited, noSource, otherLang}`, `500 repair_partial` carries `applied`. Writes `tn_rows`, `edit_log` (payload keeps the before-text). `bookImport.ts:136` → `aquiferRepair.ts:29`.
- **GET `/api/books/:book/sources`** — requireAuth; lists per-book/chapter-range source overrides (feeds C's export hold-out logic too). `bookImport.ts:138`.
- **PUT `/api/books/:book/sources`** — requireAdmin; set/clear a resource's source override (whole book, chapter range, or Aquifer-tn range); `409 overlapping_range`. Existence of the pasted repo is **not** re-checked here (caller must use `GET /api/orgs/verify-source` first). `bookImport.ts:153`.
- **POST `/api/books/:book/import`** — requireEditor (`force:true` additionally requires admin — destructive, wipes tn/tq/twl/verses/book_usfm_meta); `409 has_local_edits` (force without `confirmDiscardEdits`), `409 in_progress` (cross-isolate `book_import_locks`), `422/502 import_failed`, `200 {ok, ...counts, forced?, alreadyImported?, recovered?}`. Fetches ULT/UST/orig/tn/tq/twl from DCS in parallel, wipes+reinserts, seeds SHA watermarks, schedules tW/tA article backfill. `bookImport.ts:262`.
- **POST `/api/books/:book/reimport`** — requireEditor; body `{chapters:number[], resources:[...]}`; non-destructive — only pristine or AI-only rows are overwritten from master, a human-edited row is `skipped_edited` never clobbered. Version-CAS + pristine-predicate batched UPDATEs (≤90/batch, subrequest-cap guard), `edit_log` tagged `source='dcs_reimport'`. `409 in_progress`. `bookImport.ts:435` → `bookReimport.ts`.
- **GET `/api/pending-imports?book=&chapter=`** — requireEditor; shared review queue (not scoped to triggering user) of unresolved AI-pipeline proposals joined `pending_imports ⨝ pipeline_jobs ⨝ users`. `pendingImports.ts:40`.

---

## Bundle C — Context-Pack Export / Project Preferences / Nightly DCS Export

Mounts: `/api/exports` (`exports.ts`), `/api/project-config` (`projectConfigRoutes.ts`), `/api/l10n` (`l10n.ts`) — `index.ts:271,276,283`. Pure-library supporting files: `contextExport.ts`, `contextExportDcs.ts`, `contextExportResults.ts`, `contextSourceFetch.ts`, `projectConfig.ts`, `projectConfigApply.ts`, `assistedContextRef.ts`, `export.ts`, `postExport.ts`, `preDraftSnapshot.ts`. `exportWorkflow.ts` is a Cloudflare `WorkflowEntrypoint` class, not a router (see cron subsection).

- **POST `/api/exports/run`** — requireAdmin; body `{book?, resource?, dryDcs?, validateAndMerge?, contextOnly?, shrinkOverride?}` (empty = export everything); creates an `EXPORT_WORKFLOW` instance with a deterministic second-precision id (`409 workflow_create_failed` on double-submit same second); `contextOnly:true` routes into the context-pack-only branch. `202 {id, status:"queued"}`. `exports.ts:37`.
- **GET `/api/exports?limit=&book=`** — requireAdmin; lists `export_snapshots` including synthetic `book="CONTEXT"` rows the context-pack step writes. `exports.ts:83`.
- **GET `/api/exports/instance/:id`** — requireAdmin; `200 {id, status}` (Workflow's own step-level status) / `404 not_found` — the single status-check route for both nightly-cron and manual/context-only runs. `exports.ts:114`.
- **GET `/api/exports/resources`** — requireAdmin; `200 {resources: ALL_RESOURCES}`. `exports.ts:126`.
- **GET `/api/project-config`** — requireAuth (any authenticated user); `200 {config, presets, layouts}`. `projectConfigRoutes.ts:28`.
- **PUT `/api/project-config`** — requireAdmin; body `{preset, overrides?}` (`overrides.translationSource` strictly ident-validated at persist time for every preset — closes a path-traversal gap); known error codes `project_not_empty`, `lane_busy`, `lane_source_change_requires_migration`. `projectConfigRoutes.ts:120`.
- **PATCH `/api/project-config/mode`** — requireAdmin; body `{mode:"authoring"|"translation"}`; writes only the mode override (never trips `project_not_empty`). `projectConfigRoutes.ts:164`.
- *(`projectConfig.route("/lanes", scriptureLaneRoutes)` at `projectConfigRoutes.ts:26` mounts the scripture-lane admin routes at `/api/project-config/lanes` — documented in full under Bundle G below, not double-counted here.)*
- **GET `/api/l10n/overrides`** — any authenticated user (inline `currentUserId` check, not the shared middleware); `200 {overrides:{lang:...}, versions:{lang:number}}`. `l10n.ts:40`.
- **PUT `/api/l10n/overrides/:lang`** — requireAdmin; `If-Match` **required** (`428` if absent — including the first write, which must be `If-Match:0`); whole-bag replace, 512KB cap (`413 too_large`). `l10n.ts:61`.

### Context-pack export internals (no direct HTTP surface — reached via `POST /api/exports/run {contextOnly:true}` and the nightly cron)
`exportWorkflow.ts:exportContextPack` loads `translation_prefs`/`terminology`/validated `tn_rows`/`tq_rows`/`template_units`, fetches EN source TSVs, renders via `contextExport.ts`, applies a **semantic no-op gate** (scaffold-only pack with no prior success → `status:"no_content"`, nothing published) and a **shrink guard** (blocks a pack that would delete a large fraction of the previous pack's content unless `shrinkOverride:true` — writes a `system_alerts` row on refusal), then commits with expected-parent CAS (up to 3 retries on `context_cas_conflict`). Every branch persists to `context_export_results`, which is what `GET /api/exports` surfaces as `book="CONTEXT"` rows and what `assistedContextRef.ts` reads to pin `contextRef` into AI-pipeline drafts.

### The two active crons + one dormant one (`index.ts`, `runScheduledTick`, `index.ts:327-463`)

- **05:30 UTC `EXPORT_CRON`** (`index.ts:333-406`) — creates `EXPORT_WORKFLOW` with deterministic id `nightly-<slug>-<yyyy-mm-dd>` (double-fire on the same day 409s harmlessly, `validateAndMerge:true`, unlike manual runs). Before queuing: finalizes trashed tn notes (tombstone), cleans up old `pipeline_jobs`/`pending_imports` rows (best-effort, never blocks export). UI-visible mutations: per-`(book,resource)` commit SHA/branch/PR fields in `export_snapshots`, context-pack stats, and any `system_alerts` banners (export-lint / export-glued / context-shrink) surfaced via `GET /api/alerts/me`. Safety invariants in `exportOne`: **freshness gate** (refuses to commit unless master's SHA matches the last-synced watermark, fails closed on uncertainty — the fix for a historical alignment-reverting regression), **TSV shrink guard** (refuses a render that would delete a large fraction of master's row count — the backstop for a historical `twl_PSA` truncated-fetch clobber), **alignment-shrink backstop** (blocks a verse whose aligned-word count shrank even with identical row count/text), **locked-text drift guard** (for `textReadOnly` lanes, blocks non-alignment body-text drift).
- **Every 5 minutes `POLL_CRON`** (`index.ts:407-452`) — polls all non-terminal `pipeline_jobs` (bundle D depends on this for AI auto-apply with no tab open), backstops article population + note-template sync, sweeps stale `book_import_locks` (>10min, a crashed-Worker dangling lock that would otherwise 409 every subsequent import forever), sweeps `edit_log` rows older than 180 days (hourly).
- **08:00 UTC `REIMPORT_CRON`** — **dormant**, not registered in `wrangler.toml [env.production.triggers]` (`index.ts:128-129` comment confirms). Would dispatch a chunked DCS→D1 self-heal reimport for every book with no render/commit.

---

## Bundle D — AI Bulk Pipelines (+ tW-link suggestions/filters)

Mounts: `/api/tn-quick`, `/api/pipelines`, `/api/twl-suggestions`, `/api/twl-filters` — `index.ts:262-273`. Pure-library files with no routes (confirmed): `botOutput.ts`, `pipelineImport.ts`, `pipelineImportClaim.ts`, `rowId.ts`, `laneReopen.ts`.

### BT_API_TOKEN gating — the critical fact for a UI author

| Route | Behavior without `BT_API_TOKEN` |
|---|---|
| POST `/api/tn-quick` | `503 { error: "tn_quick_disabled" }` |
| POST `/api/pipelines/start` | `503 { error: "pipeline_api_disabled" }` |
| GET `/api/pipelines/:jobId` | `503 { error: "pipeline_api_disabled" }` (easy to miss — a read route, gated the same as the writes) |
| GET `/api/pipelines`, POST `/api/pipelines/:jobId/cancel`, POST `/api/pipelines/:jobId/notified` | **work regardless** — D1-only, no bot call |

The background dispatcher and the `*/5` cron poller also no-op with no token — a queued job never advances, so a UI in a token-less workspace could show a job stuck "queued" forever.

- **POST `/api/tn-quick`** — requireEditor; forwards a bot-contract JSON body to `uw-bt-bot.fly.dev` (32KB cap, `413`), stripping any client-supplied `contextRef`/`targetLang`/`direction` and re-injecting server-derived values (degrades to unsteered on config-lookup failure, never re-adds raw client fields); passes the bot's response through verbatim; `502 model_call_failed` on fetch failure. Synchronous single-shot, no job tracking. `tnQuick.ts:28-105`.
- **POST `/api/pipelines/start`** — requireEditor; body (zod) `{pipelineType: "translate", book?, startChapter?, endChapter?, sessionKey, translate?}` (#726: `generate`/`notes`/`tqs` are retired and get a 400; the old `options` and `followUpOptions`/`followUpChain` keys are dropped). Dedup: same user re-request on a running job → `200 already_running` (idempotent); different user → **`409 {error:"conflict", jobId, existing}`**. (The lane-writability gate, `403/409/422` from `assertLaneWritable`, was generate-only and went with it in #726.) Success: `200 running` (claimed the single global bot slot) or `200 queued {queuePosition}`; `502 upstream_error` if the bot call itself fails. `pipelines.ts:994-1278`.
- **GET `/api/pipelines/:jobId`** — requireEditor + ownership check (`403 forbidden` before any upstream call, prevents jobId enumeration); `404 not_found`; terminal jobs never re-polled upstream (a stale upstream "running" must not resurrect a cancelled job); non-terminal jobs call `pollPipelineJob` (`502 upstream_unreachable/malformed`). On a genuine `done`, imports AI output into `tn_rows`/`tq_rows`/etc, broadcasts `chapter.pipeline_applied`, frees the bot slot, advances the queue (the follow-up chain was removed in #726). One import-failure retry before force-failing the job. A job of a retired type (`generate`/`notes`/`tqs`) that ends upstream is failed as `pipeline_type_retired` without importing. `pipelines.ts:1281-1359`.
- **GET `/api/pipelines?state=`** — requireEditor, no token gate; default (no filter) = shared view: every user's active-queue jobs + caller's own non-terminal/not-yet-notified jobs, capped 100. Other users' rows have sensitive fields redacted (`session_key`, `upstream_job_id`, `output_json`, `error_kind/message` all nulled). `pipelines.ts:1545-1638`.
- **POST `/api/pipelines/:jobId/cancel`** — requireEditor + ownership; only a still-`queued` job is cancellable (`409 cannot_cancel` otherwise, race-safe re-check on the UPDATE). `pipelines.ts:1671-1707`.
- **POST `/api/pipelines/:jobId/notified`** — requireEditor (implicit ownership via the UPDATE's `WHERE user_id=`); marks the "while you were away" toast shown; always `200 {ok, changed:0|1}`. `pipelines.ts:1713-1733`.
- **GET `/api/twl-suggestions/:book/:chapter/:verse`** — **no auth** (deliberately open, like chapters/catalogs); `400 bad_ref`; else `200 {suggestions:[...]}`; exclusion of already-linked matches is client-side by design (server can't map GL text to OL occurrence). `twlSuggest.ts:63-115`.
- **GET `/api/twl-filters/:book`** — **no auth**; `200 {unlinked:[...], deleted:[...]}` deny-lists from a prior migration; cache-invalidated on a `(count, max last_synced)` signature (deliberately not `MAX(rowid)`, which SQLite can reuse after delete+reinsert). `twlFilters.ts:46-80`.

**Queue semantics:** single global bot slot (`running`/`paused_for_outage`/`paused_for_usage_limit`/`dispatching` all occupy it, claimed atomically via D1); order `priority DESC, created_at ASC` (follow-up steps get `priority=1`, jump the line). Cron-only stuck-job backstops: 48h untouched → auto-fail; >100 polls without terminal → auto-fail; `dispatching` stuck >120s → auto-fail (recovers a Worker that died mid-POST).

---

## Bundle E/F — Notes/Questions Row Editing + Approve

Mounts: `/api/rows`, `/api/chapters`, `/api/catalogs`, `/api/lexicon` — `index.ts:262-269`. `chapterLock.ts` has no routes but its semantics are documented in full below (called for by the task).

- **POST `/api/rows/:kind`** (create, `kind` ∈ tn/tq/twl) — requireEditor; per-kind zod schema; **`409 lockedResponseBody`** if an AI pipeline is running for that chapter (applies to all kinds on create); `sort_order` defaults to `MAX+100`; id-collision retried up to 8× (`503 id_collision_exhausted` on exhaustion); INSERT column list is a hardcoded allowlist (defense-in-depth). `201` full row. Broadcasts `row.upserted`, reopens tn/tq check lanes. `rows.ts:214-318`.
- **GET `/api/rows/:kind/:id?book=`** — no auth; `400 book_required`; `404 not_found` (missing or soft-deleted). `rows.ts:320-333`.
- **GET `/api/rows/:kind/:id/history?book=`** — requireEditor; replays `edit_log` into versions, synthesizes a v1 baseline for imported rows with no real create entry, filters out reorder-only "versions" except the current one. `rows.ts:356-492`.
- **PATCH `/api/rows/:kind/:id?book=`** — requireEditor; **`If-Match` mandatory** (`428 if_match_required`). Server-side corrections applied before write: OL-quote occurrence heal (forces `occurrence=1` for a Hebrew/Greek quote with null/0 occurrence), `ref_raw`→`verse` re-derivation. **Chapter-lock applies to tq/twl only — tn is exempt on PATCH** (an in-progress pipeline run is expected to coexist with a translator editing an already-"kept" tn row). No-op short-circuit (If-Match matches + no field actually changed) returns `200` unmodified, no version bump. Reorder-only patch bumps nothing but `sort_order`/`updated_at`, no `edit_log`. Normal content patch bumps `version`, demotes `translation_state` `ai_draft/validated`→`edited`. **`409 {error:"version_mismatch", current}`** is the canonical optimistic-concurrency conflict. `rows.ts:498-808`.
- **DELETE `/api/rows/:kind/:id?book=`** — requireEditor; `If-Match` mandatory; chapter-lock applies to **all kinds** here (no tn exemption, unlike PATCH); soft-delete (`deleted_at`), broadcasts `row.deleted`. `rows.ts:811-890`.
- **tn-only bit-toggle endpoints** — all requireEditor, all **lock-exempt**, all non-version-bumping (no If-Match): `POST /api/rows/tn/:id/preserve`, `/hint` (400 `note_required` if turning on with an empty note), `/validate` (Approve; 404 if `translation_state` was never set), `/keep` (legacy alias of preserve=1), `/trash`, `/restore`. Plus `POST /api/rows/tq/:id/validate` (tq analogue). All require `?book=`, all write `edit_log` + broadcast `row.upserted`. `rows.ts:1072-1245`.
- **GET `/api/chapters/:book/:chapter`** — no auth; the primary chapter-load endpoint (`{verses, tn, tq, twl, verseStatuses, verseLaneChecks}`); verses filtered to each lane's active generation (a lane mid-replacement is omitted, not stale-served); tn/tq rows carry a `latest_source` provenance chip; `\w` occurrence numbers defensively renumbered display-only. `chapters.ts:30-172`.
- **PATCH `/api/chapters/:book/:chapter/:verse/status`** — requireEditor; upserts a single done/not-done boolean, no version/If-Match concept; broadcasts `verse_status.updated`. `chapters.ts:176-220`.
- **PATCH `/api/chapters/:book/:chapter/:verse/lanes/:lane`** — requireEditor; **per-user stamp**, PK `(book,chapter,verse,lane,checked_by)` — not a single flag; response returns the full checker list; broadcasts `lane_check.updated`. `chapters.ts:251-294`.
- **PATCH `/api/chapters/:book/:chapter/lanes/:lane/bulk`** — requireEditor; same per-user-stamp model applied across a client-supplied verse list in one batch; one coalesced `lane_check.bulk` broadcast (avoids fanout storm). `chapters.ts:305-358`.
- **GET `/api/chapters/:book`** — no auth; book-level per-chapter row counts, feeds the Timeline rail. `chapters.ts:361-389`.
- **GET `/api/catalogs`** — no auth (deliberately, cache-design assumption); `{supportReferences, twLinks, disambiguationGroups, disambiguationIndex}` — autocomplete data for tN Support Reference / tW Link fields. `catalogs.ts:82-138`.
- **GET `/api/lexicon/:strong`** — no auth; `404 not_found` or a lexicon entry (exact then alpha-stripped fallback). `lexicon.ts:38-50`.
- **GET `/api/lexicon?strongs=a,b,c`** (bulk) — no auth; capped `MAX_STRONGS=2000` (`400 too_many_keys` — hard reject, never silently truncates). `lexicon.ts:52-88`.

### Chapter-lock semantics (`api/src/chapterLock.ts`, no routes of its own)
- **What locks:** any `pipeline_jobs` row covering the target chapter with state in `{running, paused_for_outage, paused_for_usage_limit, dispatching}`. A **`queued`** job does **not** lock.
- **Scope:** global, not per-user — by design, one translator's running pipeline locks the chapter for everyone.
- **Discovery:** no dedicated "check lock" GET — discovered reactively as a `409` with body exactly `{error:"chapter_locked", jobId, pipelineType, startedAt}` on a write attempt. Reuses plain `409` (not a distinct HTTP status) alongside `version_mismatch` — client must inspect `body.error` to tell them apart.
- **Acquire/release:** implicit — comes into existence when a job transitions into a non-terminal state, disappears when it leaves that set (done/failed/cancelled). No separate lock table.
- **tn asymmetry:** create/delete are lock-checked; PATCH is not (mid-run editing of an already-"kept" tn row is expected/safe).
- **Lock-exempt everywhere:** the tn/tq bit-toggle endpoints (preserve/hint/keep/trash/restore/validate) — a translator must be able to flip these mid-run.

---

## Bundle G/H — Verse Editing & Alignment (incl. Scripture-Lane Admin)

Mounts: `/api/verses` (`verses.ts`), `/api/align` (`align.ts`), `/api/project-config/lanes` (`scriptureLaneRoutes.ts`, mounted via `projectConfigRoutes.ts:26` — not a top-level path). Pure-library files (no routes, confirmed): `verseHistory.ts`, `alignmentCanonical.ts`, `alignmentDelta.ts`, `scriptureLane.ts`, `scriptureLaneReplacement.ts`.

- **GET `/api/verses/:book/:chapter/:verse/:bibleVersion`** — no auth; `bibleVersion` ∈ ULT/UST/UHB/UGNT; `409 lane_replacement_required` if the lane is quarantined with no active generation; `500` corrupt-JSON body on parse failure; else `200` with parsed usfm-js content tree. `verses.ts:96-138`.
- **GET `/api/verses/.../history`** — requireEditor; per-version `restorable` flag is `content != null` (older log-only entries aren't restorable). `verses.ts:149-229`.
- **PATCH `/api/verses/:book/:chapter/:verse/:bibleVersion`** — requireEditor. **`If-Match: <expected_version>` required** (`428` if missing/unparseable) — the app's optimistic-concurrency header for verse saves. For ULT/UST (lane-backed) an **additional `X-Source-Generation` header is required** (`428 source_generation_required`, or `409 source_generation_mismatch {expected, got}` if stale) — proves the client loaded the verse under the currently-active lane generation. Body replaces the *whole* usfm-js content tree (word alignment `\zaln-s/\zaln-e` lives inside it) plus optional `plain_text`/`alignment_intent`. `403` variants from the lane permission matrix (`source_text_is_read_only`, `scripture_text_read_only`, `scripture_alignment_read_only`, `scripture_fully_locked`, `text_content_changed_on_locked_lane`). **`409 unexpected_alignment_loss`** — the load-bearing invariant: any untouched word that lost/changed its `\zaln` source blocks the save unless `alignment_intent==="alignment_edit"` (explicit anti-regression comment citing prior data-loss incidents). `409 version_mismatch {current}`; possible chapter-lock 409 [INFERRED shape, not directly read]. `200` updated row. Broadcasts `verse.updated`, reopens check lanes. `verses.ts:231-475`.
- **GET `/api/align/suggest?bible=&keys=`** — no auth; capped `MAX_ALIGN_KEYS=2000`; reads a **separate "shared" D1** (`align_freq`, `align_freq_morph`, `lexicon_entries`), degrades gracefully on a pre-migration DB. Stateless/verse-agnostic. `align.ts:129-269`.

### Scripture-lane admin routes (mounted `/api/project-config/lanes`) — `requireAuth` minimum, most `requireAdmin`

A *lane* (`lit`=ULT, `sim`=UST) is the authoritative per-Bible-version state row (`scripture_lane_state`) layered on top of the verse save protocol: tracks an `active_generation` (verses filtered/written against `bible_version+source_generation=active_generation`, so a source swap never touches live rows until an atomic generation flip), `active_config_json` (label/source/export target/read-only flags), freeze/exclusivity fields gating whether `verses.ts` PATCH may proceed at all, and quarantine fields for a BSOJ-style mandatory replacement.

- **POST `/lanes/:lane/validate`** (requireAdmin) — dry-run normalize+impact-count of a pasted source URL. `scriptureLaneRoutes.ts:72-103`.
- **GET `/lanes/:lane/affected-books`** (requireAdmin) — book set + edit-count stats a replacement would re-stage. `scriptureLaneRoutes.ts:112-124`.
- **POST `/lanes/:lane/replacements`** (requireAdmin) — starts a replacement job; freezes the lane (CAS), stages books via `waitUntil`, broadcasts `lane.replacement_freeze`. `409` on `replacement_already_active`/`lane_lease_held`. `scriptureLaneRoutes.ts:126-214`.
- **GET `/lanes/:lane/replacements/:jobId`** (requireAuth only — read-only status). `scriptureLaneRoutes.ts:217-223`.
- **POST `/lanes/:lane/replacements/:jobId/retry-book`** (requireAdmin). `scriptureLaneRoutes.ts:225-248`.
- **POST `/lanes/:lane/replacements/:jobId/waive-book`** (requireAdmin) — `409 cannot_waive_carry_forward` (carry-forward books must be retried, never waived). `scriptureLaneRoutes.ts:250-277`.
- **POST `/lanes/:lane/replacements/:jobId/activate`** (requireAdmin) — atomically flips `active_generation` + marks job completed under a single fencing token; broadcasts `lane.replacement_settled`. `scriptureLaneRoutes.ts:279-314`.
- **POST `/lanes/:lane/replacements/:jobId/cancel`** (requireAdmin) — releases the freeze, **keeps** `replacement_required` if the lane had it. `scriptureLaneRoutes.ts:316-337`.
- **POST `/lanes/:lane/replacements/:jobId/back-out`** (requireAdmin) — full abort, deletes staged rows, reverts to prior source. `scriptureLaneRoutes.ts:339-364`.
- **PATCH `/lanes/:lane`** (requireAdmin) — body includes `configRevision` CAS token (separate from a verse's `version`); `409 config_revision_mismatch`/`lane_frozen`. Lane label/lock toggles. `scriptureLaneRoutes.ts:366-424`.

---

## Bundle I — Templates

Two parallel modules: `/api/templates` (`templates.ts` — D1-backed **translation** of note templates, migration 0053) and `/api/note-templates` (`noteTemplates.ts` — pre-existing read-only **English source** proxy over a Google Sheet). `templateSync.ts` is a pure library (sheet-diff/upsert driver, no routes).

- **GET `/api/templates?includeDeleted=`** — requireEditor; lightweight list; first-run backstop calls `ensureTemplatesPopulated` (best-effort). `templates.ts:37-60`.
- **GET `/api/templates/unit?id=`** — requireEditor; `400 id_required`, `404 not_found`. `templates.ts:63-73`.
- **PATCH `/api/templates/unit?id=`** — requireEditor; `If-Match` required (`428`); `409 version_mismatch`; demotes `ai_draft/validated`→`edited`. `templates.ts:75-143`.
- **POST `/api/templates/unit/draft?id=`** ("Draft with AI") — requireEditor; **`503 template_draft_disabled`** without `BT_API_TOKEN`; `409 already_validated` (a validated unit can never be silently overwritten even via a stale-but-matching If-Match); `413 body_too_large` (64KiB); forwards to `TEMPLATE_QUICK_URL` with the pinned contextRef. `templates.ts:145-301`.
- **POST `/api/templates/unit/validate?id=`** ("Approve") — requireEditor; non-version-bumping. `templates.ts:303-350`.
- **GET `/api/templates/unit/history?id=`** — requireEditor. `templates.ts:352-452`.
- **POST `/api/templates/sync`** — requireAdmin; manual sheet→D1 sync trigger. `templates.ts:454-459`.
- **GET `/api/note-templates`** — no auth; proxies a public Google Sheet CSV, time-bucketed `Cache-Control`; `502 templates_unavailable` on upstream failure. This is the English-source picker the note editor reads from — distinct from the D1 translation surface above. `noteTemplates.ts:160-200`.

---

## Bundle J — tW/tA Articles

Mount: `/api/articles` (`articles.ts`). `articleExport.ts`/`articlePopulate.ts` back this file but expose no routes themselves.

- **GET `/api/articles/:resource`** (tw|ta) — requireEditor; lightweight list with `latest_source` provenance chip. `articles.ts:41-55`.
- **GET `/api/articles/:resource/unit?path=`** — requireEditor. `articles.ts:58-71`.
- **PATCH `/api/articles/:resource/unit?path=`** — requireEditor; `If-Match` required (`428`); `409 version_mismatch`; first edit of an untranslated article, or demotion of `ai_draft/validated`, both become `edited`. `articles.ts:73-149`.
- **POST `/api/articles/:resource/unit/validate?path=`** ("Approve") — requireEditor; non-version-bumping. `articles.ts:151-205`.
- **POST `/api/articles/populate`** — requireEditor; body `{book?, retryFailed?, refresh?, cursor?}`; fetches missing/mismatched tA/tW articles referenced by tN/tWL rows (or refreshes existing ones); every write batch is fenced against the project config changing mid-run (`aborted:"source_changed"`). `articles.ts:207-257`.
- **POST `/api/articles/:resource/add`** — requireEditor; body `{id}`; manually adds/restores one article; `409 source_changed`. `articles.ts:259-289`.

---

## Supporting feature — Translation Memory (`api/src/translationMemory.ts`, mounted `/api/translation-memory`)

Three surfaces per the file's own header: `/prefs` (singleton), `/terms` (termbase CRUD+CSV), `/examples` (read-only browse). Supports both bundle C (context-pack export inputs) and D (AI drafting inputs).

- **GET `/prefs`** — requireEditor; returns a version-0 default if never written.
- **PUT `/prefs`** — requireAdmin; `If-Match` required (`428`); `409 version_mismatch`; on success, fire-and-forget queues a context-only export.
- **GET `/terms?status=&q=&limit=`** — requireEditor.
- **POST `/terms`** — requireEditor; `409 duplicate_term`; queues context export.
- **PATCH `/terms/:id`** — requireEditor; `If-Match` required; `409 duplicate_term/version_mismatch`; queues context export.
- **DELETE `/terms/:id`** — requireEditor; soft delete; queues context export.
- **GET `/terms/export`** — requireEditor; CSV download.
- **POST `/terms/import`** — requireEditor; raw CSV body, `?dryRun=1` for a diff-only preview; chunked UPSERT (100 rows/chunk, falls back to per-row insert within a chunk on a UNIQUE collision); queues context export.
- **GET `/terms/count`** — requireEditor.
- **GET `/examples?resource=tn|tq&supportReference=&q=&limit=`** — requireEditor; browses `validated` tn/tq rows (no dedicated examples table); known gap: omits the English source pairing.
- **GET `/export-status`** — requireEditor; latest context-pack export status for the assisted-mode/context toggle UI, falling back to the most recent non-success row or an all-null `"never"` shape.

All routes `api/src/translationMemory.ts:104-752`.

---

## Flat endpoint table

| Method | Path | Auth | Bundle | UI surface expected to call it |
|---|---|---|---|---|
| GET | /api/health | none | INFRA | health check |
| GET | /api/ws/chapter/:book/:chapter | JWT cookie (401 gate) | K | chapter WS connection |
| GET | /api/auth/dcs/start | none | AUTH | login button |
| GET | /api/auth/dcs/callback | none | AUTH | OAuth redirect handler |
| GET | /api/auth/me | JWT (inline) | AUTH | session bootstrap |
| POST | /api/auth/refresh | none (cookie-driven) | AUTH | silent token refresh |
| POST | /api/auth/logout | none | AUTH | logout button |
| PUT | /api/users/me/location | requireAuth | AUTH | last-position autosave |
| POST | /api/auth/dev | dev-only (env+localhost) | AUTH | dev auto-login |
| GET | /api/alerts/me | requireAuth | K | alert banner |
| POST | /api/alerts/:id/dismiss | requireAuth | K | dismiss alert |
| GET | /api/orgs/search | requireAdmin | A | org setup — org search |
| GET | /api/orgs/verify-source | requireAdmin | A | org setup — verify pasted source |
| GET | /api/orgs/:org/inferred-config | requireAdmin | A | org setup — draft inference |
| GET | /api/workspaces | requireAuth | A | workspace switcher list |
| GET | /api/workspaces/pool | super-admin | A | spare-pool admin view |
| POST | /api/workspaces/pool | super-admin | A | spare-pool: register slot |
| POST | /api/workspaces/pool/claim | super-admin | A | spare-pool: claim for org |
| POST | /api/workspaces/:slug | requireAuth + conditional | A | workspace switch action |
| GET | /api/admin/users | requireAdmin | A | admin user list |
| GET | /api/admin/users/org-members | requireAdmin | A | admin DCS roster reconciliation |
| POST | /api/admin/users/purge-manual | requireAdmin | A | admin: reset to team roles |
| PUT | /api/admin/users/:username | requireAdmin | A | admin: grant/change role |
| DELETE | /api/admin/users/:username | requireAdmin | A | admin: revoke role |
| GET | /api/books | none | B | imported-book list |
| GET | /api/books/:book/lint | requireAuth | B | lint feed |
| POST | /api/books/:book/aquifer-drafts | requireAdmin | B | Aquifer draft merge |
| POST | /api/books/:book/aquifer-repair | requireAdmin | B | Aquifer formatting repair |
| GET | /api/books/:book/sources | requireAuth | B | source overrides list |
| PUT | /api/books/:book/sources | requireAdmin | B | source override set/clear |
| POST | /api/books/:book/import | requireEditor (+admin for force) | B | book import action |
| POST | /api/books/:book/reimport | requireEditor | B | per-chapter/resource reimport |
| GET | /api/pending-imports | requireEditor | B | pending AI-import review queue |
| POST | /api/exports/run | requireAdmin | C | manual export trigger |
| GET | /api/exports | requireAdmin | C | export history list |
| GET | /api/exports/instance/:id | requireAdmin | C | export/job status polling |
| GET | /api/exports/resources | requireAdmin | C | export resource dropdown |
| GET | /api/project-config | requireAuth | C | preferences read |
| PUT | /api/project-config | requireAdmin | C | preset switch / config write |
| PATCH | /api/project-config/mode | requireAdmin | C | authoring/translation mode toggle |
| GET | /api/l10n/overrides | requireAuth (inline) | C | localization overrides read |
| PUT | /api/l10n/overrides/:lang | requireAdmin | C | localization overrides write |
| POST | /api/tn-quick | requireEditor (503 no token) | D | quick single-verse tN AI draft |
| POST | /api/pipelines/start | requireEditor (503 no token) | D | start AI bulk pipeline |
| GET | /api/pipelines/:jobId | requireEditor (503 no token) | D | pipeline job status |
| GET | /api/pipelines | requireEditor | D | pipeline job list/queue view |
| POST | /api/pipelines/:jobId/cancel | requireEditor | D | cancel queued pipeline job |
| POST | /api/pipelines/:jobId/notified | requireEditor | D | dismiss "while away" toast |
| GET | /api/twl-suggestions/:book/:chapter/:verse | none | D | tW link suggestions panel |
| GET | /api/twl-filters/:book | none | D | tW suggestion deny-list |
| POST | /api/rows/:kind | requireEditor | E/F | create tn/tq/twl row |
| GET | /api/rows/:kind/:id | none | E/F | read a row |
| GET | /api/rows/:kind/:id/history | requireEditor | E/F | row history/restore dialog |
| PATCH | /api/rows/:kind/:id | requireEditor | E/F | save row edit (core save protocol) |
| DELETE | /api/rows/:kind/:id | requireEditor | E/F | delete row |
| POST | /api/rows/tn/:id/preserve | requireEditor | E/F | tn: preserve-through-sweep toggle |
| POST | /api/rows/tn/:id/hint | requireEditor | E/F | tn: hint-for-AI toggle |
| POST | /api/rows/tn/:id/validate | requireEditor | E/F | tn: approve toggle |
| POST | /api/rows/tq/:id/validate | requireEditor | E/F | tq: approve toggle |
| POST | /api/rows/tn/:id/keep | requireEditor | E/F | tn: keep (legacy alias) |
| POST | /api/rows/tn/:id/trash | requireEditor | E/F | tn: move to trash |
| POST | /api/rows/tn/:id/restore | requireEditor | E/F | tn: restore from trash |
| GET | /api/chapters/:book/:chapter | none | E/F | chapter load (verses+rows+statuses) |
| PATCH | /api/chapters/:book/:chapter/:verse/status | requireEditor | E/F | verse done/not-done toggle |
| PATCH | /api/chapters/:book/:chapter/:verse/lanes/:lane | requireEditor | E/F | per-verse check-lane toggle |
| PATCH | /api/chapters/:book/:chapter/lanes/:lane/bulk | requireEditor | E/F | bulk check-lane toggle (whole chapter) |
| GET | /api/chapters/:book | none | E/F | Timeline rail summary |
| GET | /api/catalogs | none | E/F | support-ref/tw-link autocomplete |
| GET | /api/lexicon/:strong | none | E/F | lexicon popover (single) |
| GET | /api/lexicon | none | E/F | lexicon bulk preload |
| GET | /api/verses/:book/:chapter/:verse/:bibleVersion | none | G/H | verse content read |
| GET | /api/verses/:book/:chapter/:verse/:bibleVersion/history | requireEditor | G/H | verse history dialog |
| PATCH | /api/verses/:book/:chapter/:verse/:bibleVersion | requireEditor | G/H | verse/alignment save (core save protocol) |
| GET | /api/align/suggest | none | H | alignment suggestion panel |
| POST | /api/project-config/lanes/:lane/validate | requireAdmin | G | scripture source change — validate |
| GET | /api/project-config/lanes/:lane/affected-books | requireAdmin | G | scripture source change — impact preview |
| POST | /api/project-config/lanes/:lane/replacements | requireAdmin | G | start source replacement job |
| GET | /api/project-config/lanes/:lane/replacements/:jobId | requireAuth | G | replacement job status polling |
| POST | /api/project-config/lanes/:lane/replacements/:jobId/retry-book | requireAdmin | G | retry one book in replacement |
| POST | /api/project-config/lanes/:lane/replacements/:jobId/waive-book | requireAdmin | G | waive one book in replacement |
| POST | /api/project-config/lanes/:lane/replacements/:jobId/activate | requireAdmin | G | activate replacement (generation flip) |
| POST | /api/project-config/lanes/:lane/replacements/:jobId/cancel | requireAdmin | G | cancel replacement job |
| POST | /api/project-config/lanes/:lane/replacements/:jobId/back-out | requireAdmin | G | full abort/back-out of replacement |
| PATCH | /api/project-config/lanes/:lane | requireAdmin | G | lane label/lock config patch |
| GET | /api/templates | requireEditor | I | template list |
| GET | /api/templates/unit | requireEditor | I | template unit read |
| PATCH | /api/templates/unit | requireEditor | I | template unit save |
| POST | /api/templates/unit/draft | requireEditor (503 no token) | I | template AI draft ("Draft with AI") |
| POST | /api/templates/unit/validate | requireEditor | I | template approve |
| GET | /api/templates/unit/history | requireEditor | I | template history dialog |
| POST | /api/templates/sync | requireAdmin | I | manual English-sheet sync trigger |
| GET | /api/note-templates | none | I | English template picker (source) |
| GET | /api/articles/:resource | requireEditor | J | tW/tA list |
| GET | /api/articles/:resource/unit | requireEditor | J | tW/tA unit read |
| PATCH | /api/articles/:resource/unit | requireEditor | J | tW/tA unit save |
| POST | /api/articles/:resource/unit/validate | requireEditor | J | tW/tA approve |
| POST | /api/articles/populate | requireEditor | J | populate referenced articles |
| POST | /api/articles/:resource/add | requireEditor | J | manually add/restore one article |
| GET | /api/translation-memory/prefs | requireEditor | C/D | TM preferences read |
| PUT | /api/translation-memory/prefs | requireAdmin | C/D | TM preferences save |
| GET | /api/translation-memory/terms | requireEditor | C/D | termbase list |
| POST | /api/translation-memory/terms | requireEditor | C/D | termbase create term |
| PATCH | /api/translation-memory/terms/:id | requireEditor | C/D | termbase edit term |
| DELETE | /api/translation-memory/terms/:id | requireEditor | C/D | termbase delete term |
| GET | /api/translation-memory/terms/export | requireEditor | C/D | termbase CSV export |
| POST | /api/translation-memory/terms/import | requireEditor | C/D | termbase CSV import |
| GET | /api/translation-memory/terms/count | requireEditor | C/D | termbase count chip |
| GET | /api/translation-memory/examples | requireEditor | C/D | few-shot examples browse |
| GET | /api/translation-memory/export-status | requireEditor | C/D | context-export status chip |

**110 endpoints total.** Plus: 1 WS upgrade route (`GET /api/ws/chapter/:book/:chapter`, in the table above), the ChapterRoom DO's internal `POST /broadcast` (server-to-DO only, not client-reachable, not in the table), and 3 cron branches (05:30 export — live; */5 pipeline poll — live; 08:00 reimport — dormant, unregistered in `wrangler.toml`).
