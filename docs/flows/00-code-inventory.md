# Code Inventory — bible-editor web app (as-built UI surfaces)

Purpose: authoritative, exhaustive inventory of every user-facing surface, action, gating rule, and UI state in `web/src`, as a base for designing an adaptive UI. Produced by reading source directly; citations are `file:line`. Anything not directly confirmed in source is marked **[INFERRED]**.

Taxonomy used throughout:
- **A** = Stand up an org (setup wizard)
- **B** = Bring in a book (`#/import`, retired → `#/books`; see Bundle B)
- **C** = Teach the AI our style (`#/preferences/*` + context pack export)
- **D** = Bulk draft a chapter (AI menu pipelines)
- **E** = Review & approve drafts (APPROVE / APPROVE ALL)
- **F** = Author or repair one note (SUGGEST/TEMPLATE/type/Save)
- **G** = Edit literal/simplified scripture text
- **H** = Align words (alignment panel/dialog)
- **I** = Curate note templates (`#/templates`)
- **J** = Translate tW/tA articles (`#/articles/tw|ta`)
- **K** = Trust & observe (rail chips, run banners, progress)

Method note: this document was assembled by five parallel research passes over disjoint file clusters (each cluster fully read), plus direct reads of `App.tsx`, `sync/api.ts`, and a full grep of every server route registration (`api/src/*.ts`), all reconciled by hand. Where two passes touched the same file (e.g. Setup Wizard), the more thorough/verified account is kept and duplicates are merged.

---

## Cross-cutting: App shell, auth, routing (not itself a bundle)

Hash routing is parsed in `web/src/App.tsx:57-92` (`parseHash`). Five `Location` variants: `chapter` (default), `article`, `templates`, `import`, `preferences`. `App.tsx` also owns:

- **Auth gate** (`App.tsx:113-209`): boot sequence — `?_auth_denied=1` → denied screen; else `GET /api/auth/me`; 401 → dev-only silent `POST /api/auth/dev` mint or "missing" screen (prod). States: `loading` (spinner "signing in…", `App.tsx:335-341`), `missing` (Sign-in screen; shows "Queued edits stay in your browser until you sign back in." if the user explicitly signed out, `App.tsx:343-372`), `denied` (not on allowlist, offers "Sign in with a different Door43 account" → `authLogout()` then `/api/auth/dcs/start`, `App.tsx:374-399`), `error` (raw error Alert, `App.tsx:401-406`), `ready`.
- **Sign-in button**: `Button href="/api/auth/dcs/start"` "Sign in with Door43" (`App.tsx:363-365`); dev-only "Sign in (dev)" text button (`App.tsx:366-370`).
- **Sign-out**: `handleSignOut` (`App.tsx:409-427`) → `POST /api/auth/logout`, sets `SIGNED_OUT_KEY` in localStorage, clears hash, resets to default book.
- **Session-expired snackbar** (`App.tsx:568-583`): "Your session expired — sign in to keep saving. Queued edits will sync after sign-in." with inline "Sign in" action → `location.href = "/api/auth/dcs/start"`.
- **Viewer banner** (`App.tsx:487-492`): global info Alert, "You're signed in as an unfoldingWord member — read-only access. Edits won't be saved…", shown whenever `role === "viewer"`.
- **System alerts stack** (`App.tsx:441-486`): `GET /api/alerts/me` (via `useAlerts`), fixed-position filled Alerts (severity error/warning/info) with dismiss (`POST /api/alerts/:id/dismiss`) and an optional "view run" `https://` link.
- **Workspace reconciliation** (`App.tsx:284-312`): compares localStorage workspace slug against `me.workspace`; on mismatch, syncs and does a one-time guarded `location.reload()`.
- **Last-location hydration** (`App.tsx:274-282`) and **debounced push** (`App.tsx:316-323`, `PUT /api/users/me/location`).
- **`WorkspaceChoiceDialog`** (`App.tsx:584`, own component) — one-time post-OAuth org picker (see bundle-adjacent §E.2 below).
- Route mounting: `preferences` → `PreferencesWorkspace` (bundle C/A/K, no TopBar variance — it has its own header); `article` → `TopBar(showNavigation=false)` + `ArticleWorkspace` (bundle J); `templates` → bare `TemplateWorkspace`, **no TopBar at all** (bundle I) — inconsistency flagged in §I below; `import` → `ImportWorkspace` (bundle B); default → `Shell` (bundles D/E/F/G/H/K).

---

## Bundle A — Stand up an org (Setup Wizard)

**Entry point:** rendered inside `PreferencesWorkspace` when `section === "setup" && role === "admin"` (`web/src/components/PreferencesWorkspace.tsx:327-334`), reached via the admin-only "Setup" rail item (`PreferencesWorkspace.tsx:262-279`). Component: `web/src/components/SetupWizard.tsx:75`. **Gating: admin role only** — no feature flag.

### A.1 Step 1 — "Your organization" (`OrgIdentityFields.tsx:25`, mounted `SetupWizard.tsx:278`)
- Org name: read-only, from `GET /api/workspaces` (`OrgIdentityFields.tsx:38-44`; `api.ts:2284`).
- Auto-runs org inference once per org: `GET /api/orgs/{org}/inferred-config` (`OrgConfigDraftEditor.tsx:96-120`; `api.ts:1645-1646`).
- **"Retry detection"** button (`OrgIdentityFields.tsx:109`) — re-fires detection.
- Resource-language `Autocomplete` (freeSolo) — local only, seeds `languageCode/languageName/direction`.
- **Next** button, disabled until draft + resourceLang set (`SetupWizard.tsx:282-286`).
- States: loading spinner (line 91), detection-failure warning Alert + Retry (95-115), workspace-lookup error alert (83).

### A.2 Step 2 — "Sources (pull FROM)" (`UpstreamSourcePicker.tsx:119`, mounted `SetupWizard.tsx:295`)
- Upstream org field, verify-on-blur (line 185). `unfoldingWord` auto-verified with no round trip; anything else → `GET /api/orgs/{org}/inferred-config` (line 149).
- **Retry** button on unreachable/unverified state (196-200).
- Per-resource row (lit/sim/tn/tq/twl/tw/ta, lines 30-112): "pull from upstream" checkbox (default checked); unchecked reveals **"Leave blank"** vs **"Use a different source"** toggle group — the latter mounts `SourceOverrideField` (A.4).
- Blocking Alert when a non-default upstream org isn't verified (203-209); Apply/Next blocked (`SetupWizard.tsx:300`).
- Warning listing resources still on an unverified override (217-225).

### A.3 Step 3 — "Your scripture lanes: target + edit/align" (`LaneTargetModeStep.tsx:24-168`, mounted `SetupWizard.tsx:313`)
- Per lane (lit, sim): **Target repo** field (disabled/"locked" once populated, `laneSourceEstablished()` in `setupWizard.ts:314-316`).
- **Edit vs Align** toggle group (90-98) — local, applied post-Apply as `lanePatch`.
- **Upstream for this lane** toggle group (105-114): unfoldingWord / a URL / None — URL choice mounts `SourceOverrideField`.
- Inline "From → To" summary (118-125). **Next** disabled until both `repos.lit`/`repos.sim` set (`SetupWizard.tsx:322-327`).

### A.4 Shared `SourceOverrideField` (`SourceOverrideField.tsx:21-154`)
Reused by A.2, A.3, B.4, and the Scripture-Lanes "change source" flow (§A.7).
- Verify-on-blur via `GET /api/orgs/verify-source?url=...&checkBooks=1` (`api.ts:1657-1660`; `checkBooks` only for lit/sim).
- States: idle → verifying (spinner) → verified (green Alert + clickable `RepoRef`) → error (`invalid`/`not_found`/`unreachable`/`no_books`, each own i18n copy; `unreachable` gets Retry).
- A verify failure never silently blanks the field — kept as a pending override, blocking Apply until resolved (design note lines 33-40).

### A.5 Step 4 — "Review & apply" (`SetupWizard.tsx:333-437`, `ReviewSummary` 479-595)
- Two-column FROM/TO summary table per resource.
- Warning Alerts: locked-lane-blocked, incomplete draft, upstream unverified, unverified-override list, apply-error.
- **Apply** button → `PUT /api/project-config` `{preset:"custom-gl", overrides}` (`useProjectConfig.ts:145-152`; `api.ts:1630-1634`). Disabled while applying/applied/blocked.
- On success: `PATCH /api/project-config/lanes/{lane}` per lane (`api.ts:2238-2249`).
- **409 handling** (`setupWizard.ts:288-298`): `lane_source_change_requires_migration` → per-lane **"Revert `<lane>` to `<repo>`"** buttons (371-384); `project_not_empty` same org → **"Revert all repos"** (385-394); different org → hard stop, no revert offered.
- If the lane-mode patch fails post-Apply → **"Retry lane mode"** button (407-417) (re-Apply would itself 409).

### A.6 Step 5 — "Configured" (`SetupWizard.tsx:440-468`)
- **"Go to Import"** → `#/import` (local nav). **"Open editor"** → `#/` (local nav). Hands off directly into bundle B.

### A.7 Scripture Lanes admin (`ScriptureLanesSection`, `PreferencesWorkspace.tsx:333,379-423`; `LaneCard` 425-992) — rendered under Setup, not a separate route
- Two lane cards (lit/sim). Current-source chip, "Replacement required/active" status chips (726-732).
- **Text read-only / Alignment writable** switches → `PATCH /api/project-config/lanes/{lane}` `{field, configRevision}` (503-516).
- **"Change source"** flow:
  1. Paste URL → **"Change source"** → `GET /api/orgs/verify-source?checkBooks=1` (531-559) — hard-blocks on `hasBooks:false`, soft-retries on transient failure.
  2. `POST /api/project-config/lanes/{lane}/validate` (562; `api.ts:2145-2155`) → impact counts → confirm Dialog.
  3. Dialog: `GET /api/project-config/lanes/{lane}/affected-books` (570-582; `api.ts:2181-2190`) — per-book replace/keep chips (unedited pre-checked replace, edited default keep), Select-all/none, required "I understand" checkbox gating Confirm.
  4. **Confirm** → `POST /api/project-config/lanes/{lane}/replacements` `{config, confirm:true, replaceBooks?}` (592-638; `api.ts:2157-2175`) — async replacement job.
  - Job polled every 3s (`LaneCard.tsx:462-489`) via `GET .../replacements/{jobId}` (`api.ts:2192-2195`).
  - Per-book progress chips: green filled (`artifact_ok`), red outlined-clickable (`retryable_error`/`failed`, click=**Retry** → `POST .../retry-book`, `api.ts:2215-2219`), default (`absent_authorized`), warning (else); deletable × = **Waive** (confirm + `POST .../waive-book`, `api.ts:2224-2228`).
  - **Activate** button (job `ready`) → `POST .../activate` with fresh `crypto.randomUUID()` fencing token (`api.ts:2232-2236`).
  - **Back out** button (any time, `window.confirm`) → `POST .../back-out` (`api.ts:2207-2211`) — full revert.
  - Error-code→copy map: `replacement_already_active`, `lane_lease_held`, `confirmation_required`, `lane_replacement_required`, `job_not_found`, `job_not_ready`, `export_lease_held`, `export_lease_grace`, `activation_cas_failed` (`PreferencesWorkspace.tsx:117-128`).
- **This is a strong K (trust & observe) job-progress pattern embedded in an A surface** — flagged as a template for a generalized "run/job progress" component.

### A.8 Users section (`UserManagementSection.tsx:56`, admin-only, `#/preferences/users`, mounted `PreferencesWorkspace.tsx:337-338`)
- **Add user**: username field + role Select (editor/admin) + **Add** → `PUT /api/admin/users/{username}` `{role}` (94-116; `api.ts:2262-2266`). Unverified DCS user → info toast.
- Allowlist table: per-row role Select (inline → same PUT, warns if team-managed), **delete** icon (confirm) → `DELETE /api/admin/users/{username}` (`api.ts:2267-2274`).
- "Not org member" warning chip per row not in live DCS roster (322-335).
- **Purge manual grants** button (confirm dialog partitioning "will lose access" vs "team-backed") → `POST /api/admin/users/purge-manual` (`api.ts:2278-2281`).
- Read-only live DCS org roster panel: `GET /api/admin/users/org-members` (`api.ts:2257`), fails soft.
- **Does not fit A/B/C/D/K cleanly** — org access/role administration; closest neighbor is A but it's a standing rail item, not part of the wizard. Treated here as an A-adjacent appendage per its Setup-rail proximity.

---

## Bundle B — Bring in a book (`#/import`)

> **Retired (2026-08-24).** `ImportWorkspace` and the `#/import` route no longer
> exist. The workflow below now lives on the Books screen
> (`web/src/components/flows/BooksScreen.tsx` + `BringInBookDialog.tsx`, PR #305
> A3); `#/import[/BOOK]` redirects to `#/books[/BOOK]` and the chapter/verse tail
> is dropped. The rest of this section is kept as the as-built record of what the
> replacement had to cover.


**Entry point:** `App.tsx:75-83` parses `#/import(/:book(/:chapter(/:verse)))`; rendered `App.tsx:544-553`. No role gate at route level (per-book source-override writes are admin-gated, see B.4).

### B.1 Left rail — book list (`ImportWorkspace.tsx:135-239`)
- `GET /api/books` (line 98; `api.ts:1704`) → tri-state `booksStatus` (loading/loaded/error). **Safety-critical**: a failed fetch shows explicit error+Retry, never silently falls back to an all-"not imported" list (`importIntent.ts:90-110`).
- Search field filters the 66-book canon list (121-133), local only.
- Each row: code + name + chip "Imported" (green) / "Not imported" (227-233); click → `#/import/:book`.
- Retry button on error (189).

### B.2 Main pane — book detail (`BookImportPane`, `ImportWorkspace.tsx:301-575`)
- Header: code/name, imported-state chip (424-446).
- **Intent** toggle: "Translate a new book" vs "Load my existing work" (462-467), local, default from `defaultIntent(imported)` (`importIntent.ts:24-26`).
- **Advanced** accordion → `BookSourceOverridesPanel` (B.4), collapsed by default (475-486).
- **Primary action**, via `importActionFor(imported, intent)` (`importIntent.ts:42-50`) — never returns a destructive action for an already-imported book:
  - Not imported → **"Import `<book>`"** → `POST /api/books/{book}/import` `{translateFromSource?}` (`ImportWorkspace.tsx:351-354`; `api.ts:1716-1740`, 120s timeout). Success Alert lists source repos used; failure Alert shows server message.
  - Imported → **"Open"** button → navigates into the editor (no API call, 503-509).
  - Imported → **"Re-pull"** button → opens `ImportFromDoor43Dialog` (B.3, 510-517).
- **"AI Translate"** button (shown only when `effectiveImported && isTranslationProject(cfg)`, line 419) → `startBookAiTranslate()` (`lib/aiTranslate.ts:41-82`) — loops per-chapter `POST /api/pipelines/start` (bounded concurrency 4) for both `translate` and `{resourceType:"tq"}`. **This is a bundle-D action embedded in a bundle-B surface.** Result classified success/partial/failed toast (`importIntent.ts:77-85`).
- Message/warning/error Alerts, dismissible (543-557).

### B.3 Re-pull dialog (`ImportFromDoor43Dialog.tsx:100-275`)
- Chapter/range field (e.g. "1-50"), validated via `parseChapterRange` (124); defaults to whole book when opened from B.2 (`importIntent.ts:61-67`).
- 5 resource checkboxes (ULT/UST/tN/tQ/TWL, 201-252) — last-used selection persisted to **localStorage** `bible-editor.import.door43.options` (51-83), not server state.
- Warning if nothing selected (253-257).
- **Import** button → `POST /api/books/{book}/reimport` `{chapters, resources}` (line 144; `api.ts:1746-1757`, 120s timeout) — explicitly non-destructive (only never-human-touched rows overwritten); tallies `updated/reimported_ai/inserted/skipped_edited/skipped_locked/skipped_noop/source_attr_reconciled/dcs_404`.
- Errors by status: 404 not-imported, 409 already-running, 401 sign-in, 422 invalid (server detail), else generic.

### B.4 Per-book source overrides (`BookSourceOverridesPanel.tsx:35-310`, mounted in B.2's Advanced accordion)
- **Read** any role: `GET /api/books/{book}/sources` (line 47; `api.ts:1665-1668`) — chips: whole-book vs chapter-range, DCS `RepoRef` or "Aquifer (`lang`)".
- **Write admin-only** (`isAdmin()`, line 37); non-admins see read-only list + caption.
- Add-form: Source type (DCS/Aquifer), Resource (tN/tQ, forced tN for Aquifer), From/To chapter, URL (DCS only).
  - DCS: verifies URL (`api.verifySource`) then `PUT /api/books/{book}/sources` `{resource, org, repo, chapterStart?, chapterEnd?}` (110-118; `api.ts:1676-1691`).
  - Aquifer: `PUT .../sources` `{resource:"tn", kind:"aquifer", chapterStart, chapterEnd}` (100-107), no verify, language derived server-side.
  - Server codes: `overlapping_range` (409), `range_needs_both_bounds`/`aquifer_needs_range`, `aquifer_language_unavailable`, 403 admin-only.
- **Remove** button per override (admin only) → `PUT .../sources` `{..., clear:true}` (`api.ts:1695-1702`).

### B.5 AI menu's own import/pull entries (see D.6 — "Import from Door43" and "Pull Aquifer drafts" menu items live in the chapter-scoped AI menu, not this workspace, but perform closely related actions)

---

## Bundle C — Teach the AI our style (`#/preferences/*` memory sections + context pack export)

**Entry point:** `App.tsx:57-61,494-502`; component `PreferencesWorkspace.tsx:180`.

### C.0 Shell / rail
- Left rail: memory sections (`brief, instructions, commonIssues, terminology, examples`) shown only when `memoryAvailable = isTranslation && !isReadOnly()` (`PreferencesWorkspace.tsx:184,236-261`). Admin-only extra rail items: **Setup** (→ A), **Localization** (→ "unmapped", §Unmapped), **Users** (→ A.8).
- All sections always mounted; rail click both sets hash and smooth-scrolls (`scrollToSection`, 169-171,242-245).
- **Org switcher** (`WorkspaceSwitcher variant="expanded"`) at top, all roles (line 326) — see §Unmapped/E (workspace infra).
- **`ContextPackStatusControls`** (998-1078), all roles: status chip via `GET /api/translation-memory/export-status` (`api.ts:1983-1984`); **"Export now"** (admin-only, disabled+tooltip otherwise) → `POST /api/exports/run` `{contextOnly:true}` (`api.ts:1985-1994`), polls status ×8 @1.5s; **"Export (force)"** (only when `status==="shrink_refused"`, admin) → same endpoint `{shrinkOverride:true}` — escape hatch for an intentional content-shrink the server's shrink-guard refused. 403→"forbidden" snackbar, else generic-failure.

### C.1 Brief section (`PreferencesWorkspace.tsx:1376-1488`)
- Fields: Audience, Purpose, Register (Select), Script notes — bound to a shared `TranslationPrefs` draft, seeded once so sibling-section saves can't clobber unsaved typing.
- **Save** → `PUT /api/translation-memory/prefs` `If-Match: <version>`, only Brief's fields (1395-1403; `api.ts:1977-1982`).
- 409 handling: adopts server's fresh row from the conflict body directly (`prefsConflict.ts:14-23`) rather than refetch — snackbar "conflictKeptEdits". 403→"save forbidden".

### C.2 Instructions / Common issues (`MarkdownPrefSection`, `PreferencesWorkspace.tsx:1493-1636`)
- Same `TranslationPrefs` row, fields `instructions_md` (20,000-char cap) / `common_issues_md` (50,000-char cap).
- **Preview** toggle → `MarkdownView` render instead of textarea (1567-1576,1581-1584).
- Char-count helper, error state past cap, Save disabled over-limit.
- **Save** → same `PUT .../prefs` pattern; 409/403/400("too long")/generic.

### C.3 Terminology section (`PreferencesWorkspace.tsx:1700-1798`, row CRUD 1800-2317)
- Search (debounced 300ms) + Status filter (`TERM_STATUSES`) → `GET /api/translation-memory/terms?status=&q=` (`useTranslationMemory.ts:103-142`; `api.ts:1999-2005`), capped 500 rows.
- **Import** toggle → inline CSV paste panel: **Preview (dry run)** / **Apply import** → `POST /api/translation-memory/terms/import?dryRun=1|0` (`text/csv`; `api.ts:2021-2026`) — shows added/updated/error/warning counts + capped 20-line error/warning list.
- **Export** button (anchor download, no fetch) → `GET /api/translation-memory/terms/export` (CSV).
- **Add term** row: concept ID, source term, target term, status Select, conditional "replacement" (required if forbidden), comment → `POST /api/translation-memory/terms` (`api.ts:2007-2012`); 409 `duplicate_term` surfaced distinctly.
- Terms grouped by `(concept_id, source_term)`; **"Add rendering"** toggles inline row, same create endpoint.
- Each rendering row: **Edit** mode (target term/status/replacement/comment) → **Save** → `PATCH /api/translation-memory/terms/{id}` `If-Match` (`api.ts:2013-2018`); two distinct 409s (`duplicate_term` stays in edit, `version_mismatch` exits+refetches). **Delete** icon → `DELETE /api/translation-memory/terms/{id}` (`api.ts:2019-2020`).

### C.4 Examples section (`PreferencesWorkspace.tsx:2454-2581`)
- Resource toggle (Notes/Questions), debounced search, "feeding AI" chip (from export-status).
- `GET /api/translation-memory/examples?resource=&supportReference=&q=&limit=200` (`useTranslationMemory.ts:145-184`; `api.ts:2030-2038`).
- **Revoke** button per example → `POST /api/rows/tn/{id}/validate?book=` `{value:false}` (or tQ equivalent) — un-approves so it drops out of the validated-examples set.

### C.5 (see §Unmapped) Localization editor — admin-only, edits the app's own UI chrome i18n, not translation content; kept out of C proper.

---

## Bundle D — Bulk draft a chapter (AI menu pipelines)

**Entry point:** the "AI" button (`AutoAwesomeIcon`, `PipelineMenu.tsx:440-447`), chapter-scoped, opens a `Menu`.

### D.1 Menu contents (`PipelineMenu.tsx:75-120,223-239`)
> **Removed in #470:** the three base pipeline types below (and D.2's "What to generate" checkboxes and the asymmetric follow-up) are gone from the menu. Translation-mode projects now show only the two translate items; the English root project shows no AI items, only the import entries. The rest of this section is the snapshot as it was.

Always shown (3 base pipeline types):
| key | label | description | duration |
|---|---|---|---|
| `generate` | "Generate ULT + UST" | "Aligned literal + simplified text and a draft issues list for the chapter." | ~60–100 min |
| `notes` | "Write translation notes" | "Translation notes (tn) for every verse in the chapter." | ~30–60 min |
| `tqs` | "Write translation questions" | "Translation questions (tq) aligned to the current ULT/UST." | ~30–60 min |

Translation-mode-only (GL projects, `isTranslationProject(projectConfig)`; hidden, not disabled, for the English root project):
| key | label | description |
|---|---|---|
| `translate` | "Translate chapter" | "AI-translate this chapter's notes from the source language." |
| `translate-tq` | "Translate questions" | "AI-translate this chapter's questions from the source language." |

**Finding:** no 6th "chain macro" menu item is actually wired in today — `followUpChain` was scaffolded in types/plumbing (comment "Currently used by the 'Generate everything' macro") but no `OPTIONS`/`TRANSLATE_OPTION` entry set it. (#726 removed `followUpChain` and `followUpOptions` entirely.) **Today's menu is 5 items in translation-mode projects, 3 in root/English projects — not 6.**

Item `secondary` text becomes "Already running ({{state}})" and disables the item when *this user's* own job covers the chapter; a different user's in-flight run does not disable the item — it opens the confirm dialog and hits the 409 conflict path instead (`PipelineMenu.tsx:261-279,450-469`).

Divider + always-visible: **"Import from Door43"** → opens `ImportFromDoor43Dialog` (472-483,517-524; see B.3/B.5).

Admin + translation-project only (`canPullAquifer = isAdmin() && isTranslationProject`):
- **"Pull Aquifer drafts"** → `runAquifer()` (372-395) → synchronous `POST` via `api.aquiferDrafts(book)` (no server job/lock, a local busy spinner only). Success: "{{book}}: {{approved}} approved, {{inserted}} drafts added to review." Errors: `aquifer_book_not_available`, `book_not_imported`, generic.
- **"Re-source notes from English"** → `runResource()` (397-436,674-712) — two-step confirm: (1) warn dialog "Re-source notes from English?" → `api.importBook(book,{translateFromSource:true, force:true})`; (2) on 409 `has_local_edits`, sharper dialog with exact counts (tn/tq/twl/verses) → **"Discard and re-source"** repeats with `confirmDiscardEdits:true`. 403→admin-only message.

### D.2 Start-confirmation dialog (`PipelineMenu.tsx:525-640`)
- Chapter/range field (digits + `-`), helper text single vs multi-chapter run count. A multi-chapter range fires **one `pipelineStore.start()` call per chapter** (300-314), not one ranged job.
- **"What to generate" checkboxes** (generate only): ULT (literal text) / ULT alignment (indented, needs ULT) / UST (simplified text) / UST alignment (indented, needs UST) — persisted to `localStorage["bible-editor.pipeline.generate.options"]` (134-164), reloaded on every open. Asymmetric align (ULT≠UST alignment choice) shows italic note and is wired as **two chained pipelines** (`followUpOptions`, ULT first) so the chapter stays locked through both (186-201). Neither-checked → warning, Start disabled.
- Buttons: Cancel, Start (disabled while submitting/invalid/nothing-selected).
- **On submit**: `POST /api/pipelines/start`. Response `status`: `running`/`queued`/`already_running`.
  - Single-chapter queued: toast "Queued: {{label}} for {{range}} — #{{position}} in line" (or "waiting in line" if no position).
  - Running / multi-chapter: toast "Started: {{label}} for {{range}} ({{n}} runs)".
  - `already_running`: no toast, `pipelineStore` fires a focus event auto-opening the status popover.
  - **409 conflict** → "Already running" dialog: who started it, pipeline-type + scope, relative-time, state + current_skill + updated-time, italic "This chapter is locked while the pipeline runs… will overwrite this one when it completes." Close-only, no cancel/take-over. Falls back to a bare toast "Another translator already started this pipeline (job {{jobId}})." if no `existing` metadata (started outside the editor, e.g. Zulip).
  - 401 → "Sign in to start a pipeline." Other ApiError → "Could not start: {{error}}." Network error → generic "check your connection" message.

### D.3 Full option surface (`api.ts:1017-1039,1262-1282`) — only a subset is user-facing
- `PipelineRequestOptions`: `model` (not exposed in UI), `fresh` (not exposed), `contentTypes` (checkbox-driven), `noAlign`/`alignOnly` (not exposed), `textOnly` (checkbox-driven), `noIntro`/`pauseBeforeATs` (notes-only, not exposed).
- `TranslateRequestOptions`: only `resourceType` set by the UI (via the translate-tq menu item); everything else (`articleId/articleUrl/model/delivery/branchOnly/direction/rowIds/verseStart/verseEnd/targetLang/targetOrg/sourceRef/contextRef/literalRef/simplifiedRef`) is server-derived from project config (`api.ts:1013-1016`). **[INFERRED]** other call sites (single-note Translate button, `aiTranslate.ts`'s book loop) may set `rowIds`/`resourceType` beyond what was directly traced.

### D.4 Note-level one-shot AI ("sparkles") — `useAiDrafts.ts` / `tnQuickRequest.ts` / `AiCompletionToasts.tsx`
Distinct from chapter pipelines: single-note quick-draft button on a TN NoteCard.
- `buildTnQuickRequest` (`tnQuickRequest.ts`) — two modes: English-first-draft vs original-language-regenerate, detected from whether `row.quote` contains Hebrew **or Greek** (`isOriginalLanguageQuote`). Typed failure reasons: `missing_support_reference`/`missing_quote`/`missing_ult_verse`/`missing_ust_verse`/`hebrew_not_found` (the English path failed to align)/`source_quote_not_found` (the OL path failed to align — separate reason so call sites don't hand a Hebrew/Greek quote the "copy the English support phrase" advice; #346).
- `useAiDrafts.start()` (`useAiDrafts.ts:142-250`) — fire-and-forget per row, abortable/restartable, auto-retries once on `502 model_call_failed` after 2s.
- **Completion display**: in-viewport → 4s pulse highlight, no toast; off-screen → stacked toast "AI draft ready · v{{verse}}" with **View** (scroll+activate) and dismiss, stacked above `SyncStatusBar`.
- **Error map** (`mapAiError`, `useAiDrafts.ts:67-105`), auto-hide 8s: `unknown_issue_type`, `unknown_book`, `no_rtl`, `hebrew_words_not_in_verse`, `body_too_large`, `rate_limited` (wait 30s), `model_call_failed` ("AI service unavailable"), **`tn_quick_disabled`** → "AI not configured — admin must set BT_API_TOKEN" (**the BT_API_TOKEN-absence gate for this surface — reactive only, discovered on first click, never proactively hidden**), `anthropic_api_key_missing`, `cache_unavailable`, `uhb_missing_for_verse`, `unauthorized`, default HTTP-status message.

### D.5 Note-template one-shot & bulk AI drafting (`useTemplateAiDraft.ts`/`useTemplateBulkDraft.ts`/`bulkDraft.ts`)
Analogous to D.4 but for note templates (`TemplateWorkspace`, bundle I surface):
- Single-unit draft: `POST /api/templates/unit/draft`, AutoAwesome icon button; error map mirrors D.4 plus `version_mismatch` (captures server's fresh row, retry uses current version).
- **Bulk "Draft all with AI ({{n}})"** — worker-pool concurrency 3; 3 consecutive failures aborts (`aborted_failures`); a single 503 `template_draft_disabled` is immediately terminal; 429 gets one fixed 2s-wait retry. Progress row "Drafting {{n}}/{{total}}…" + Cancel. Result copy: disabled/failed(code)/cancelled/done-partial/done.

### D.6 Book-level AI Translate — see B.2 (embedded in the Import workspace, not the AI menu)

### D.7 Session/queue plumbing (not itself a surface, drives D.1–D.5)
`pipelineSession.ts` — per-tab UUID session key (localStorage, namespaced by user id) distinguishing "you clicked twice" from "someone else started this." `pipelineStore.ts` — polls every 120s while visible+active; reconciles on visibility-regain/mount; foreign jobs visible read-only (attributed, no cancel); "while you were away" completions retro-fire the completion toast for jobs <24h old with `notified_user_at===null`; dismiss/dismissAll is localStorage-only.

---

## Bundle E — Review & approve drafts

### E.1 NotesPanel "Approve All" (`NotesPanel.tsx:114-201`, translationMode only)
- Progress bar + "{validated}/{total}" count, "🧠 language memory" tooltip.
- **APPROVE ALL** button → loops `onNoteApprove(id,true)` over every draft id → `POST /api/rows/tn/:id/validate` `{value:1}` per row (`api.ts:1847-1852`).

### E.2 NoteCard Approve/Unapprove (`NoteCard.tsx:1703-1775`, hidden when read-only)
- **Approve** (draft state) → `POST /api/rows/tn/:id/validate` `{value:1}`.
- **Unapprove** (validated + expanded) → same endpoint `{value:0}`.
- (Translate/Re-run buttons on the same row belong to bundle D, not E — they trigger `pipelineStore.start`.)

### E.3 QuestionsPanel "Approve All" (`QuestionsPanel.tsx:133-146`) — identical shape to E.1, over tQ rows.

### E.4 QuestionCard Approve/Unapprove (`QuestionCard.tsx`) — `POST /api/rows/tq/:id/validate` `{value:1|0}` (`api.ts:1856-1861`).

### E.5 Note: TWL (translationWordsLinks) has **no Approve concept at all** — `TwlRow` carries no `translation_state`/`latest_source` fields; there is no bundle-E equivalent for words. QuestionsTable (English-authoring, non-translation-mode) likewise has no Approve — approval only exists in translationMode.

### E.6 Examples-section "Revoke" (`PreferencesWorkspace.tsx:2472-2483`, bundle C surface) is the inverse of Approve (un-validates a row so it drops out of the AI-context example set) — cross-referenced here since it's the same `validate` endpoint family.

---

## Bundle F — Author or repair one note

### F.1 NoteCard (`NoteCard.tsx`, 2072 lines — largest single surface in the app)
Header row: drag-grip + up/down reorder, support-reference picker (`CatalogPicker`, local until Save), reference chip (verse retarget / bridge-span menu, local), state chip (ai_draft/Aquifer-draft/edited/validated/untranslated, plus a lock chip for unapproved drafts when `getLockUnapprovedDrafts()` pref is on), "Show source" (expand collapsed-validated card, local), version chip → `NoteHistoryDialog` (F.2), AI-provenance chip (`latest_source==="ai_pipeline"`), **Undo** icon (reverts to last-saved, clears IndexedDB draft, only when dirty), **Save** icon → `PATCH /api/rows/tn/:id?book=` `If-Match:<expectedVersion>` (`api.ts:1794-1809`), "+" insert-after icon, **Trash** icon → `POST /api/rows/tn/:id/trash?book=` (`api.ts:2043-2046`), Restore icon (only when trashed) → `POST /api/rows/tn/:id/restore?book=` (`api.ts:2049-2052`).

Quote block: quote textarea (debounced 200ms local propagate, RTL/LTR auto), translate-icon adornment (local, resolves via alignment), **"Build from source"** button → opens `QuoteBuilderPopper` (F.4).

Source/draft pairing (translationMode): pinned read-only English source note; **TEMPLATE** button → menu of curated templates filtered by support-ref, confirm-replace if note non-empty, else applies via local `stashEdit`; **SUGGEST** button (disabled unless supportRef+quote set) → `onStartAi` (D.4's `/api/tn-quick`), confirms first if note non-empty.

Footer chips: **Preserve** toggle → `POST /api/rows/tn/:id/preserve?book=` `{value}` (`api.ts:1826-1831`, mutually exclusive with Hint); **Hint** toggle (hidden read-only) → `POST /api/rows/tn/:id/hint?book=` `{value}` (`api.ts:1836-1841`); **TCM**/**SH** canned-template quick-fill chips (local); row-id chip (display).

States: unsaved dirty border + `data-dirty`, IndexedDB draft persistence every keystroke, AI-completion pulse, read-only lock overlay (`locked && !preserve && !hint`), collapsed-validated green one-liner, RTL/LTR auto-direction. Gating: `readOnly = trashed || lockUnapproved || (locked && !preserved && !hint)`.

### F.2 NoteHistoryDialog (`NoteHistoryDialog.tsx`)
`GET /api/rows/tn/:id/history?book=` on open (`api.ts:1789-1792`). Version list + snapshot/diff toggle + word-level diff. **"Switch to vN"** (hidden if card is read-only) routes through the normal save path: `onSave(patch,{restoredFromVersion})` → same `PATCH` with `restored_from_version` folded in.

### F.3 QuestionCard / QuestionsTable
QuestionCard (translationMode): Save icon → `PATCH /api/rows/tq/:id` `If-Match`; Delete icon (hard delete, no trash/restore — TWL-style, unlike tN's soft-trash); source block pinned read-only; question/response fields hidden entirely for untranslated rows. QuestionsTable (English-authoring / non-translation mode): dense grid, editable Ref field (unlike tN's picker), Question/Response fields, Save/Delete icon-buttons, same draft-persistence pattern.

### F.4 WordsTable / QuoteBuilderPopper / TwlSuggestions
- **WordsTable** (`WordsTable.tsx`): per-row quote (orig_words) field + translate-icon, occurrence field, TW-article picker + disambiguation menu + "read article" icon (`TwArticleDialog`), gloss caption (read-only), Save/Undo/Delete icons — same PATCH+If-Match shape. Manual drag/arrow reorder is present but **disabled by a kill-switch** (`ENABLE_TWL_MANUAL_REORDER=false`) — TWL is now canonically ordered by source-word position. "Locate" hover-preview icon, "Build from source" icon → `QuoteBuilderPopper`. Whole table dims/disables (`pointerEvents:none`) when chapter-locked.
- **QuoteBuilderPopper** (`QuoteBuilderPopper.tsx` + `lib/quoteBuilder.ts`) — shared cross-panel picker (opened from NoteCard or WordsTable): click/shift-click source (UHB/UGNT) words to select a run, click a ULT/UST target chip to toggle its full alignment-ancestor chain; live quote+occurrence preview; Cancel/Use-selection. No direct API call — the built string reaches the server only via the calling card's own Save.
- **TwlSuggestions** (`TwlSuggestions.tsx`) — additive, session-local suggest/reject/disambiguate layer on top of WordsTable: `GET /api/twl-suggestions/{book}/{chapter}/{verse}` (`api.ts:1608-1612`); per suggestion, ambiguity Select + **Add** (→ `POST /api/rows/twl` create via `resolveSpanToSource`) + **Reject** (client-only, never persisted) + read-article icon; filtered against `useTwlFilters`' deny-lists (`GET /api/twl-filters/{book}`); collapses to "Suggestions paused — Words checked here" when the Words lane-checkoff is done for that verse.

**None of F.4's TwlSuggestions/QuoteBuilderPopper fit E or F cleanly** — flagged as their own additive-authoring-tool category, adjacent to F but not literally "author or repair one note."

---

## Bundle G — Edit literal/simplified scripture text

Applies uniformly across all three scripture-view modes (rows/columns/book — see `ScriptureColumn.tsx:402-540` mode-switcher toolbar, itself K-adjacent chrome not G content).

### G.1 Rows mode (`ScriptureColumn.tsx:728-996`, `ActiveLine` 1201-1721)
- contentEditable verse body, `onInput` → local draft write (IndexedDB) on every keystroke — **no PATCH until Save**.
- Paragraph-marker toolbar (`\p \m \q1 \q2 \q3 \b \ts*`) inserts a literal-marker chip at caret, draft-write only.
- **Save** icon → `smartEditVerse` → `PATCH /api/verses/{book}/{ch}/{v}/{bibleVersion}` `If-Match:<expectedVersion>` (outbox-enqueued).
- **Undo** icon (only when a draft exists) → clears IndexedDB draft, resets DOM — no API call.
- Section-header band (`\s1/\s2/\s3`) edit/delete → splices verseObjects, re-saves via the same PATCH pipe.
- Align button (`AlignLinkButton`) — entry into bundle H, not G itself.
- Version-history chip → `VerseHistoryDialog` (out-of-bundle per file-4 agent, "K-adjacent"; restore-click is a G action).
- Gating: `editable = !locked && !textLockedVersions.has(version)`; UHB/UGNT always read-only.
- States: dirty orange inset shadow, active-verse blue halo, reorder "stoplight" underline/overline during TN drag, find-overlay marks override note highlights.

### G.2 Columns mode (`DocColumn.tsx`)
- One `DocColumn` per enabled version. Per-verse: align button, **text-lane check icon** (bundle K, not G) → `PATCH /api/chapters/{book}/{ch}/{v}/lanes/{lane}`, Undo/Save icons + contentEditable span (identical PATCH shape to G.1), section-header edit. Column header shows `CopyChapterButton` (§Unmapped) and "(read-only)" caption for UHB/UGNT/locked/frozen columns.

### G.3 Book mode (`BookView.tsx`, lazy per-chapter `IntersectionObserver`)
- Identical per-verse-cell control set to G.2, addressed by `(chapter, verseNum, bibleVersion)`.
- **Book mode's `locked` gating is coarser than the others**: any chapter shown in book view is locked whenever the *active* chapter is mid-pipeline, by explicit design choice (`BookView.tsx:98-101` comment) — not per-chapter.
- States: chapter-unloaded (dashed placeholder), chapter-loading (spinner), chapter-load-error (red band + message), instant (not smooth) scroll-to-active after eager-loading ±2 rows.

### G.4 Find/Replace — Bible scope only (`FindReplaceOverlay.tsx`)
- Toggle-able regex/case-sensitive/Strong's-number search, Bible/TN scope checkboxes (at least one required), prev/next navigation, book-mode "load full book" affordance for full-book search coverage.
- **Replace** (single) → `smartReplaceVerse` → same verse-PATCH pipe. **"Replace all"** (warning-styled) → confirm dialog stating exact blast radius (N verses / M matches) → one PATCH per affected verse, **no bulk undo**. Read-only/frozen versions silently skipped, counted in the post-replace summary Alert.
- (TN-scope replace is a bundle-F action living in the same overlay component, not G — see F.1's Save semantics; it never touches `id`/`support_reference`, blocks a would-empty-the-note replace.)

### G.5 Export USFM (`ExportUsfmButton.tsx`) and Copy Chapter (`CopyChapterButton.tsx`) — **client-side read-export utilities, no PATCH/API write at all** (Export fetches read-only `GET`s to assemble the file; Copy is pure clipboard). Excludes UHB/UGNT from exportable versions. See §Unmapped — these don't fit G's "edit" framing even though they operate on the same content, since they perform no mutation.

---

## Bundle H — Align words

### H.1 Alignment Panel (`AlignmentPanel.tsx`)
- Toolbar: unaligned-count chip, selection count+clear, Colors toggle (localStorage `be:alignmentColorize`), Hover-link toggle (`be:alignmentHoverLink`, default off standalone), Show-only-unaligned/Show-all, resizable chip-strip height (`be:alignmentInventoryHeight`), drop-zone-to-unalign on the strip itself.
- UHB/UGNT source strip (`UhbStrip.tsx`): collapse/expand, hover tooltip (`SourceTooltipBody`), double-click → `PinnedLexBox` popover (copy-lemma, close).
- **Alignment cards grid** — the core drag-and-drop surface: drag an English target chip (or an unaligned-strip chip) onto a card to (re)align it; drag a source word onto a card to retarget/merge; drag a card's grip handle onto another card to merge whole groups. Drop-target visual states: hover, merge-target (dashed border overlay), being-dragged (dimmed). Per-card **Clear (×)**. Double-click a multi-word source → extract it out. **Ghost/suggestion chips** (dashed, confidence-colored dot — wordMAP memory vs lexicon) — click to accept, × to dismiss for the session. Double-click an aligned English chip → unaligns it.
- Action bar: version-history chip (K-adjacent, out-of-bundle), **"Side-by-side"** button (standalone only) → opens H.2, "Accept N suggestions" (bulk-accept ghosts), **Clear** (unaligns everything in the verse), **Reset** (disabled unless dirty, reverts + clears crash-draft), Cancel (hidden in side-by-side embed), **Save** (disabled unless dirty).
- **Save flow**: serializes state → `onSave` → outbox verse PATCH `If-Match`. **Unalign confirm gate**: if saving would leave a previously-aligned word bare, the save is deferred pending a caller-supplied confirm dialog.
- **Crash-draft recovery**: every drag persists to a dedicated IndexedDB store (`alignmentDrafts.ts`, debounced 400ms), restored silently on mount if the version/generation still match, with a "restored unsaved alignment" Snackbar (6s auto-hide). Lane-frozen drafts are never restored this way (quarantined).
- Gating: alignment only ever applies to target versions (ULT/UST) — UHB/UGNT source is always read-only render; `isLaneFrozen` blocks crash-draft persistence and restore.

### H.2 Side-by-Side Aligner (`SideBySideAligner.tsx`)
- Full-screen dialog hosting two `AlignmentPanel` instances (ULT+UST) sharing one Hebrew/Greek source strip. Titlebar: prev/next-verse arrows, verse-ref chip, "Hebrew info" checkbox (tooltip toggle, default off), Close (no internal dirty-gate — caller must check both panels' imperative `isDirty()` before closing).
- Per-side **`ReadingLine`** strip (a **G-shaped** action inside an H surface): small contentEditable plain-text line, explicit Save/Undo, **locked while that side's AlignmentPanel is dirty** (documented rationale: a same-side text save would swap the verse prop and wipe pending drags).
- Shared source strip renders the union of both sides' coverage once; hover cross-highlights both panels.
- Hover-link defaults **ON** here (distinct localStorage key from H.1's default-off).

### H.3 Bundle mapping note
H.2 explicitly mixes G (ReadingLine text edit) and H (the two embedded aligners) in one dialog — flagged as not a clean split.

---

## Bundle I — Curate note templates (`#/templates`)

**Entry point:** `App.tsx:536-543`, `#/templates(/:templateId)`, component `TemplateWorkspace.tsx:79`. **Gating: `isTranslationProject(cfg)`** — non-translation projects see only a "GL only" message, no rail, no editor. **No role gating found in the component** (no `isReadOnly()`/`isAdmin()` check present — confirmed by grep) — enforcement, if any, is server-side only and un-surfaced client-side.

**Finding:** this route renders with **no TopBar at all** (`App.tsx:536-543`), unlike the article route which gets a stripped-down TopBar (`App.tsx:512-521`). No Status indicator, Account menu, theme/font/language control, or reachable sign-out except via the in-page Back arrow. No comment in source explains whether this asymmetry is deliberate — flagged for the redesign.

### I.1 Left rail (`TemplateWorkspace.tsx:189-380`)
- Back arrow (203-207) → `onBack()`.
- Search field (248-255), client-side filter, local only.
- **"Draft all with AI"** / Cancel — see D.5.
- Bulk-result Alert (dismissible).
- Per-template row → `onNavigate(id)` → `#/templates/{id}`; stale-source warning dot (`stale_source===1`); unsaved-draft dot (Kindle color, from IndexedDB drafts subscription); `StateChip` (ai_draft/edited/validated).
- Grouped by `type`; approved-count caption "n/total".
- States: loading spinner, load error, no-matches empty state.

### I.2 Main editor — `TemplateEditor` (`TemplateWorkspace.tsx:410-863`)
- Load: `GET /api/templates/unit?id=` (`api.ts:1926-1927`), then restores/validates any IndexedDB draft against fresh server version (stale-draft warning if server moved on).
- Action bar: **History** icon → `TemplateHistoryDialog` (I.3); **"Draft with AI"** (D.5); **Save** → `PATCH /api/templates/unit?id=` `If-Match:<version>` (`api.ts:1932-1937`); **Approve** (draft states) → `POST /api/templates/unit/validate?id=` `{value:1}` (`api.ts:1954-1959`); **Unapprove** (validated) → same `{value:0}`; Preview/Edit toggle (local); target TextField — draft-persists on every keystroke, **no network until explicit Save** (matches the app-wide "save only on click" rule).
- **409 handling**: rebases from the conflict body's `current` unit (keeps the translator's in-progress draft text untouched) — warning snackbar "saveConflict".
- Collapsed-validated banner (click to expand), same pattern as F's NoteCard.

### I.3 TemplateHistoryDialog (`TemplateHistoryDialog.tsx:53`)
- `GET /api/templates/unit/history?id=` (`api.ts:1962-1963`) on open.
- Source/Target toggle (source = raw English revision history, no diff; target = translated-version list + snapshot/diff), version list, Snapshot/Diff toggle (diff disabled on the current version), word-level diff. **"Use vN"** → pulls old text into the draft (still requires an explicit Save — no direct write here).

---

## Bundle J — Translate tW/tA articles (`#/articles/tw|ta`)

**Entry point:** `App.tsx:503-534`, `#/articles/{tw|ta}(/{articleId})`, component `ArticleWorkspace.tsx:102`. **Gating: same `isTranslationProject(cfg)` gate**, same GL-only fallback message. **No client-side role gating found** (same caveat as bundle I).

Unlike Templates, this route **does** get a TopBar (`showNavigation={false}` variant, `App.tsx:512-521`) — so Status/Account/theme/font/language remain reachable here but not from `#/templates`.

### J.1 Left rail (`ArticleWorkspace.tsx:231-396`)
- Back arrow; tW/tA toggle → `onNavigate(v,"")` → `#/articles/tw` or `#/articles/ta` (no trailing slash, to avoid mis-parsing as a chapter route); approved-count caption; search field (client-side).
- **"Populate from books"** (empty-state only) → loops `POST /api/articles/populate` (`api.ts:1905-1916`) until exhausted/aborted (200-iteration guard); snackbar reports outcome.
- **"Add [query]"** (empty or no-match state) → `POST /api/articles/{resource}/add` (`api.ts:1892-1900`); 400 `source_not_found` → friendly "unknown id" message; success navigates to the new article.
- Per-article row → `onNavigate(resource, id)`; unsaved-draft dot; aggregate `StateChip` (ai_draft wins > edited > validated-only-if-every-part-validated > none).

### J.2 Main editor — `ArticleEditor` (`ArticleWorkspace.tsx:443-945`)
An article is 1 (tW: body) or up to 3 (tA: title/sub-title/body) independently-versioned parts; the action bar acts on all dirty parts together.
- Load: `GET /api/articles/{resource}/unit?path=` per part (`api.ts:1869-1870`); per-part draft restore + staleness flag.
- **Save** → `Promise.allSettled` of `PATCH /api/articles/{resource}/unit?path=` `If-Match` per dirty part only (`api.ts:1874-1879`) — a 409 on one part doesn't abort the others (that part keeps its edit, conflict snackbar, no destructive reload).
- **Approve** (draft states, skips untouched parts to avoid a 404) → `POST /api/articles/{resource}/unit/validate?path=` `{value:1}` (`api.ts:1882-1887`); **Unapprove** (validated) → `{value:0}`.
- **Translate / Re-run AI** (untranslated or draft) → `pipelineStore.start({pipelineType:"translate", translate:{resourceType, articleId}})` — an async pipeline job (bundle-D mechanism reused here), completion clears spinner + reloads via `pipelineStore.onComplete`.
- Per-part Preview/Edit toggle; per-part TextField — draft-persists per keystroke, no network until Save.
- Collapsed-validated banner (same pattern as I/F).
- Snackbars: staleDraft (no auto-hide), conflict (6s), generic error (6s).

---

## Bundle K — Trust & observe

### K.1 Chapter-lock banner + completion routing (`Shell.tsx`)
- **`chapterLock`** (`Shell.tsx:769-791`) derived from `pipelineStore`'s job list: `running`/`paused_for_outage`/`paused_for_usage_limit`/`dispatching` locks the chapter (queued does NOT lock).
- **Persistent banner** (`Shell.tsx:3672-3691`): *"AI {{pipelineType}} run in progress for {{book}} {{chapter}} — started {{started}}. Editing is locked for this chapter. You can still mark notes to keep before the new set lands."* — this is the literal "chapter locked by pipeline" banner.
- **Locked-edit-dropped toast**: an outbox op against a locked chapter gets a 409 `chapter_locked`, is silently dropped (not retried/quarantined — comment: "the auto-apply will overwrite this row anyway"); user sees a toast *"Edit dropped — the AI run for this chapter is mid-flight. Try again after it finishes."*
- **Completion routing** (`Shell.tsx:729-750`): job `done` + chapter currently open → *"New AI {{pipelineType}} are ready for this chapter. Save your work, then refresh."* toast with inline **Refresh** action (does not auto-refetch, to avoid clobbering in-progress edits) — this is the literal "New AI translate are ready…refresh" banner from the brief. Job `done`, chapter not open → plain success toast *"AI {{pipelineType}} applied to {{book}} {{start_chapter}}."* Job `failed` → error toast with **the raw `error_kind` enum value interpolated verbatim** (`transient_outage`/`auth_error`/`usage_limit`/`sdk_error`/`non_success_result`/`missing_output`/`stale_output`/`interrupted`/`import_failed`) — **no i18n/friendly mapping exists anywhere for any `PipelineErrorKind` value** (confirmed by repo-wide grep); `interrupted` in particular would render literally as the word "interrupted" with zero explanation.
- **`PipelineStatusResponse.interrupted?: boolean`** exists in the type but has **zero consumers anywhere in `web/src`** (confirmed by grep) — dead field, no interrupted-run indicator exists beyond the generic failed-state + raw error_kind string.

### K.2 Status pill / popover (`PipelineStatusBar.tsx`, embedded in `StatusIndicator.tsx`)
- Chip hidden entirely unless there's something to show; label priority: "{{n}} pipeline(s) running" (+queued count) → "{{n}} queued" → "{{n}} failed" → "AI ready to review" (idle-done only). Color primary/default/error/success. Dismissable × only when nothing of the user's own is active/queued.
- Bottom-center Snackbar toast mirrors severity, optional inline action.
- Popover job list: per-job icon (hourglass/spinner/check/error/block/pause), title, subline (**raw, non-i18n'd English state strings** — "queued"/"starting…"/"running"/"paused (outage)"/"paused (daily budget)"/"failed"/"cancelled"/"done" — a **finding**: these bypass the app's i18n layer entirely, unlike everything else in the component), queue position, foreign-job "requested by {{user}}" note, follow-up-chain "Step 1/2 of 2" labels, verbatim server `error_message` when present (contrast with K.1's toast which shows the raw `error_kind` enum instead — two different raw-string leaks in two different places). Actions: **Cancel** (queued+own only) / **Dismiss** (failed/cancelled). **Stage bar**: per-pipeline-type ordered dot-stepper (Draft→Align→Push for generate; Draft→Batch→Push for notes; Draft→Push for tqs; Draft→Push for translate, with unknown skills just showing "running"). Footer: Refresh (manual reload), Dismiss all.

### K.3 Chapter Board / lane-check matrix (`ChapterBoard.tsx`)
- Dialog presenting every verse × every `CHECK_LANES` (`text/tn/tw/tq`) as a grid. Per-cell checkbox → outbox-enqueued `PATCH /api/chapters/{book}/{ch}/{v}/lanes/{lane}` (upsert). Column "check all" (confirm-gated upstream, per its own doc-comment) → `PATCH /api/chapters/{book}/{ch}/lanes/{lane}/bulk`. Per-lane visibility eye-toggle (feeds `TimelineRail`). Footer per-lane progress bar + "{done}/{applicable}" (this is the literal "x of y approved"-shaped counter, though scoped to lane-checks not note-approval). Non-applicable cells show "–" with tooltip. Gated by an upstream `canCheck` prop (role/mode gate computed by the caller).
- Inline shortcut versions of the same lane-check icon appear per-verse in rows/columns/book scripture modes (§G.2/G.3) — same PATCH endpoint, same shading model (open/mine/other/both, `laneChecks.ts`).

### K.4 Original-language reference (`HebrewLine.tsx`, `UhbStrip.tsx`, `PinnedLexBox.tsx`, `OriginalLanguagePanel.tsx`)
Read-only throughout: hover tooltip (lemma/gloss/definition/tW hint), double-click → pinned popover with copy-lemma. `OriginalLanguagePanel` is a standalone resource-column panel exposing the same rendering with click-to-navigate rows. No G/H action anywhere in this cluster.

### K.5 Version-mismatch / app-update nudge (`useAppVersion.ts`, surfaced in `StatusIndicator.tsx`)
Polls `/version.json` every 5 min + on refocus/reconnect (skipped in dev); flips `updateAvailable` once (no un-flip); `StatusIndicator` shows a "Refresh" affordance inside its popover when true. This is the version-mismatch toast referenced in the brief.

### K.6 SyncStatusBar (embedded in `StatusIndicator.tsx`)
The outbox save-state pill: saved/saving/conflicts/failed/offline/unsaved-drafts. Always mounted twice — once visibly in the TopBar's merged `StatusIndicator`, once invisibly (`hideInlineChip`) at the app root so the conflict/discard dialog machinery works even when the popover is closed.

### K.7 BookLintIndicator / useBookLint
DCS-validation "issues to clean up" chip — book-level lint findings split into `flag` (needs human decision) vs `escalate` (integrity, e.g. footnotes) buckets, merged cosmetically into `StatusIndicator`'s popover. Not itself AI or content-editing; a K-only surface.

### K.8 WS presence (`useChapterRoom.ts` / `sync/wsClient.ts`)
One WS per `(book,chapter)` room, listen-only (heartbeat ping/pong every 20s, 40s pong-timeout force-close, exponential-backoff reconnect 1s→30s). Dispatches: `row.upserted/deleted`, `verse.updated`, `verse_status.updated`, `lane_check.updated/bulk`, `lane.replacement_freeze/settled`, `chapter.pipeline_applied`. Drives live reconciliation across all G/H/E/F surfaces without a UI of its own beyond the states listed above.

### K.9 UnsavedToasts (`UnsavedToasts.tsx`) — verse-drafts only
Bottom-left toast stack for **off-screen unsaved verse drafts** (IntersectionObserver on `data-find-cell`); >3 unsaved collapses to an aggregated "Review" chip; per-toast Save/dismiss/jump-to. **Does not cover Templates/Articles** (I/J), which use the rail dirty-dot instead — a genuinely separate "N unsaved" mechanism per bundle, not one unified component.

---

## Cross-cutting infrastructure (spans multiple bundles, not itself content)

### Outbox (`sync/outbox.ts`)
Every mutating action (verse text, row patch, verse-status, lane-check) is written to an IndexedDB queue before any network call. Drain worker dispatches one op at a time per target, cross-tab-locked (`navigator.locks`). 200 → op removed, sibling ops re-threaded to the new version. **409** → auto-heals silently for sort_order-only / non-colliding patches (up to 5 retries), else surfaces a `conflictCurrent` merge-prompt state (blocks further ops to that target until resolved — the literal "409 merge prompt" from the brief; the prompt UI itself lives downstream, not in this file). **401** → silent-refresh-and-retry without burning the attempt budget. **5xx/408/425/429** → exponential backoff, capped ~10 min (20 attempts) before becoming a user-facing failed op. **Chapter-locked 409** → op dropped outright. **Lane-frozen** → verse ops quarantined (`status:"failed"`, reason `quarantined`) without ever hitting the network. Offline → drain pauses, resumes on `online`/`focus`.

### Drafts (`sync/drafts.ts`)
Every editable field (verse text, row field, article part, template) stashes a plain-text draft to IndexedDB on every keystroke, independent of the outbox — nothing PATCHes until an explicit Save click, matching the app-wide "Save only on click, never on blur/unmount" rule. Auto-clears on a matching 200 (unless quarantined by a lane freeze, in which case the recovery copy survives).

### Alignment Drafts (`sync/alignmentDrafts.ts`) / Lane Freeze (`sync/laneFreeze.ts`)
Same crash-safety pattern as drafts.ts but for in-progress alignment drags (separate IndexedDB store). Lane Freeze is a synchronous module-level flag set the instant the WS delivers `lane.replacement_freeze`, so outbox/drafts can reject writes immediately without waiting on an async config reload.

### Layout chrome (`LayoutMenu.tsx`, `WorkspaceLayout.tsx`, `PanelChrome.tsx`) — local-only, no API calls
Save-current-as-layout / rename / duplicate / delete (confirm-gated) dialogs; drag-to-resize panels; minimize (hides via `display:none`, does not unmount — preserves scroll/draft state); "closed regions" reopen strip. All persisted to `localStorage`.

---

## Unmapped section — surfaces that fit none of A–K cleanly

1. **Workspace switching** (`WorkspaceSwitcher.tsx`, `WorkspaceChoiceDialog.tsx`) — `GET /api/workspaces`, switch via `POST /api/workspaces/{slug}` → persist slug → **hard `location.reload()`** (blocks the switch entirely if the outbox has pending ops — "unsaved edits" warning). Four render variants (expanded/indicator/menuItem/legacy menu). `WorkspaceChoiceDialog` is the one-time post-OAuth org-disambiguation picker. Org/workspace-selection infrastructure, not a content workflow.

2. **Localization editor** (`PreferencesWorkspace.tsx:1093-1368`, admin-only, `#/preferences/localization`) — edits the editor's **own UI chrome** i18n strings (not translation content): English-reference column + editable-override column per namespace, live search auto-expanding matching groups, "Inspect mode" switch (toggles the `LocalizationInspector` overlay below), Save (`PUT /api/l10n/overrides/{lang}` `If-Match`, 409→reload-keep-draft), Export (client-side blob download), per-field dropped-placeholder-token warning. An "app localization / i18n admin" bucket distinct from bundle C's translation-content memory.

3. **`LocalizationInspector.tsx`** — admin-only, cross-route overlay (mounted at app root, active on every route): hover-to-highlight + click-to-edit any matched UI string in place, draggable floating toolbar (Pause/Exit), same `PUT /api/l10n/overrides/{lang}` save path as #2. Admin tooling, not a content workflow.

4. **User Management / org administration** (`UserManagementSection.tsx`, bundle A.8 above) — kept documented under A for proximity (it's a Setup-adjacent standing rail item) but is genuinely its own "org access administration" category, distinct from org-setup, import, AI-teaching, bulk-drafting, or trust/observe.

5. **`LogosSyncToggle.tsx`** — desktop-Logos-app handoff via a custom `logosref:` URL scheme; Open-in-Logos icon button + "Auto-follow" checkbox (confirm dialog on first enable, "don't show again" persisted). **Zero server interaction** — entirely `localStorage`-backed personal convenience tool. Visibility toggled from TopBar's More▸View menu.

6. **`SearchPanel.tsx`** — a sandboxed external-tool `iframe` (`https://swunrow.pythonanywhere.com/`) mounted as a Flexible-layout panel option. No app-state actions of its own; an embedded external tool, not a first-party workflow.

7. **Export USFM / Copy Chapter** (`ExportUsfmButton.tsx`, `CopyChapterButton.tsx`) — pure client-side read-export utilities (file download / clipboard write); no PATCH, no mutation. Operate on bundle-G content but perform no editing action, so they don't fit G's "edit" framing despite the adjacency.

8. **TN-scope Find/Replace** (inside `FindReplaceOverlay.tsx`, see G.4) — edits translation-note bodies via the scripture Find/Replace overlay; content-wise this is a bundle-F action (note authoring) but the surface itself is shared chrome with bundle G's Bible-scope replace, and neither the G nor F rubric cleanly claims the whole component.

9. **TopBar "More" menu — View section** (reading-text-size stepper, dark/light theme toggle, interface-language submenu, "Show Logos sync" visibility toggle) — pure view/display preferences, not tied to any content workflow. `TopBar.tsx:918-1009`.

10. **Version-history browsing itself** (`NoteHistoryDialog`, `TemplateHistoryDialog`, `VerseHistoryDialog`) — the *browsing* half of history is a K-shaped "observe past state" action; only the "Switch to/Use vN" *restore* click routes back into F/G/I. Treated here as K-adjacent-but-unassigned rather than forced into K.3–K.9's list, since the task's K definition ("rail chips, run banners, progress") doesn't obviously cover a history diff viewer.

---

## Handle registry — every distinct backend endpoint the frontend calls

Grouped by server route file (`api/src/*.ts`, mounted per `api/src/index.ts:226-283`). Method + path as registered; `If-Match` column notes whether the client sends a version-CAS header (per `sync/api.ts`).

### Auth (`index.ts` inline + `auth.ts`)
| Method + path | If-Match | Surfaces |
|---|---|---|
| `GET /api/auth/dcs/start` | – | Sign-in button, denied-screen "sign in as different account" |
| `GET /api/auth/dcs/callback` | – | OAuth redirect target (not a client fetch) |
| `GET /api/auth/me` | – | App boot auth gate |
| `POST /api/auth/refresh` | – | Silent 401/csrf-mismatch recovery (`sync/api.ts` `request()`) |
| `POST /api/auth/logout` | – | Sign-out, denied-screen "different account" flow |
| `POST /api/auth/dev` | – | Dev-only silent mint |
| `PUT /api/users/me/location` | – | Debounced last-location push |
| `GET /api/ws/chapter/:book/:chapter` | – (WS upgrade) | `useChapterRoom`/`wsClient` presence |

### Alerts (`alerts.ts`)
| `GET /api/alerts/me` | – | App-level system-alert banner stack |
| `POST /api/alerts/:id/dismiss` | – | Alert dismiss × |

### Books / import (`bookImport.ts`)
| `GET /api/books` | – | Import rail |
| `GET /api/books/:book/lint` | – | BookLintIndicator |
| `POST /api/books/:book/aquifer-drafts` | – | AI menu "Pull Aquifer drafts" |
| `GET /api/books/:book/sources` | – | BookSourceOverridesPanel read |
| `PUT /api/books/:book/sources` | – | BookSourceOverridesPanel add/clear (admin) |
| `POST /api/books/:book/import` | – | Import primary action; AI menu "Re-source from English"; book-level AI-translate precheck |
| `POST /api/books/:book/reimport` | – | Re-pull dialog (`ImportFromDoor43Dialog`) |

### Chapters (`chapters.ts`)
| `GET /api/chapters/:book/:chapter` | – | `useChapter` main chapter payload |
| `GET /api/chapters/:book` | – | `useBook` summary |
| `PATCH /api/chapters/:book/:chapter/:verse/status` | – | Verse-status "done" toggle |
| `PATCH /api/chapters/:book/:chapter/:verse/lanes/:lane` | – | Per-verse lane-check toggle (inline + ChapterBoard) |
| `PATCH /api/chapters/:book/:chapter/lanes/:lane/bulk` | – | ChapterBoard "check all" |

### Rows (`rows.ts`) — tn/tq/twl
| `POST /api/rows/:kind` | – | Row create (new note/question/word-link, TwlSuggestions "Add") |
| `GET /api/rows/:kind/:id` | – | (single-row fetch, incidental) |
| `GET /api/rows/:kind/:id/history` | – | NoteHistoryDialog |
| `PATCH /api/rows/:kind/:id` | Yes | NoteCard/QuestionCard/WordsTable/QuestionsTable Save |
| `DELETE /api/rows/:kind/:id` | Yes | QuestionCard/WordsTable hard delete |
| `POST /api/rows/tn/:id/preserve` | – | NoteCard Preserve chip |
| `POST /api/rows/tn/:id/hint` | – | NoteCard Hint chip |
| `POST /api/rows/tn/:id/validate` | – | NoteCard/NotesPanel Approve/Unapprove/Approve-All; Examples-section Revoke |
| `POST /api/rows/tq/:id/validate` | – | QuestionCard/QuestionsPanel Approve/Unapprove/Approve-All |
| `POST /api/rows/tn/:id/keep` | – | [INFERRED] translation-mode "keep this draft" action during a chapter lock (named in route list, call site not directly traced) |
| `POST /api/rows/tn/:id/trash` | – | NoteCard Trash |
| `POST /api/rows/tn/:id/restore` | – | NoteCard Restore |

### Verses (`verses.ts`)
| `GET /api/verses/:book/:chapter/:verse/:bibleVersion` | – | (single-verse fetch, incidental) |
| `GET /api/verses/:book/:chapter/:verse/:bibleVersion/history` | – | VerseHistoryDialog |
| `PATCH /api/verses/:book/:chapter/:verse/:bibleVersion` | Yes (+ optional `X-Source-Generation`) | Rows/Columns/Book text Save; Alignment Panel Save; FindReplace "replace"/"replace all"; VerseHistoryDialog restore |

### Catalogs / lexicon / TWL support (`catalogs.ts`, `lexicon.ts`, `twlSuggest.ts`, `twlFilters.ts`, `noteTemplates.ts`, `align.ts`)
| `GET /api/catalogs` | – | CatalogPicker type-ahead (support-refs, tW links, disambiguation groups) |
| `GET /api/lexicon/:strong` | – | PinnedLexBox / hover tooltip lookups |
| `GET /api/lexicon` | – | [INFERRED bulk variant, not directly traced] |
| `GET /api/twl-suggestions/:book/:chapter/:verse` | – | TwlSuggestions |
| `GET /api/twl-filters/:book` | – | useTwlFilters deny-lists |
| `GET /api/note-templates` | – | NoteCard TEMPLATE menu (`useNoteTemplates`, cached in localStorage) |
| `GET /api/align/suggest` | – | Alignment Panel ghost-suggestion chips |

### Exports (`exports.ts`)
| `POST /api/exports/run` | – | Preferences "Export now" / "Export (force)" (context-pack) |
| `GET /api/exports/` | – | [INFERRED list, not directly traced] |
| `GET /api/exports/instance/:id` | – | [INFERRED status detail] |
| `GET /api/exports/resources` | – | [INFERRED] |

### tn-quick (`tnQuick.ts`)
| `POST /api/tn-quick` | – | NoteCard SUGGEST button (single-note AI draft) |

### Pipelines (`pipelines.ts`)
| `POST /api/pipelines/start` | – | AI menu (all 5 pipeline types), book-level AI-translate loop, NoteCard/QuestionCard Translate/Re-run, ArticleWorkspace Translate |
| `GET /api/pipelines/:jobId` | – | PipelineStatusBar polling |
| `GET /api/pipelines/` | – | pipelineStore full-queue reconcile |
| `POST /api/pipelines/:jobId/cancel` | – | PipelineStatusBar "Cancel" (queued+own only) |
| `POST /api/pipelines/:jobId/notified` | – | pipelineStore "while you were away" ack |

### Pending imports (`pendingImports.ts`)
| `GET /api/pending-imports/` | – | [INFERRED — Phase-2b placeholder list per `api.ts` comment, no confirmed UI consumer traced in this pass] |

### Project config (`projectConfigRoutes.ts` + `scriptureLaneRoutes.ts` mounted at `/lanes`)
| `GET /api/project-config` | – | `useProjectConfig` shared cache (gates translation-mode across many bundles) |
| `PUT /api/project-config` | – | SetupWizard Apply |
| `PATCH /api/project-config/mode` | – | TopBar Account-menu Editor/Translator mode flip (admin-interactive) |
| `PATCH /api/project-config/lanes/:lane` | – | SetupWizard post-Apply lane-mode; ScriptureLanesSection Text/Alignment switches |
| `POST /api/project-config/lanes/:lane/validate` | – | ScriptureLanesSection "Change source" step 1 |
| `GET /api/project-config/lanes/:lane/affected-books` | – | ScriptureLanesSection confirm-dialog book list |
| `POST /api/project-config/lanes/:lane/replacements` | – | ScriptureLanesSection Confirm (start replacement job) |
| `GET /api/project-config/lanes/:lane/replacements/:jobId` | – | ScriptureLanesSection job-status poll |
| `POST /api/project-config/lanes/:lane/replacements/:jobId/retry-book` | – | ScriptureLanesSection per-book Retry |
| `POST /api/project-config/lanes/:lane/replacements/:jobId/waive-book` | – | ScriptureLanesSection per-book Waive |
| `POST /api/project-config/lanes/:lane/replacements/:jobId/activate` | – | ScriptureLanesSection Activate |
| `POST /api/project-config/lanes/:lane/replacements/:jobId/cancel` | – | [INFERRED — route exists, no direct UI call site traced; back-out is used instead] |
| `POST /api/project-config/lanes/:lane/replacements/:jobId/back-out` | – | ScriptureLanesSection Back out |

### Orgs (`orgRoutes.ts`)
| `GET /api/orgs/search` | – | [INFERRED — org-name autocomplete, not directly traced to a component in this pass] |
| `GET /api/orgs/verify-source` | – | SourceOverrideField, ScriptureLanesSection "Change source" step 1 |
| `GET /api/orgs/:org/inferred-config` | – | OrgIdentityFields / UpstreamSourcePicker detection |

### Workspaces (`workspaceRoutes.ts`)
| `GET /api/workspaces` | – | WorkspaceSwitcher, WorkspaceChoiceDialog, OrgIdentityFields |
| `GET /api/workspaces/pool` | – | [INFERRED — spare-workspace-pool admin flow, not directly traced to a UI component in this pass] |
| `POST /api/workspaces/pool` | – | [INFERRED, same] |
| `POST /api/workspaces/pool/claim` | – | [INFERRED, same] |
| `POST /api/workspaces/:slug` | – | WorkspaceSwitcher / WorkspaceChoiceDialog switch |

### Admin users (`adminUserRoutes.ts`)
| `GET /api/admin/users/` | – | UserManagementSection allowlist table |
| `GET /api/admin/users/org-members` | – | UserManagementSection live DCS roster |
| `PUT /api/admin/users/:username` | – | UserManagementSection add/edit role |
| `DELETE /api/admin/users/:username` | – | UserManagementSection delete |
| `POST /api/admin/users/purge-manual` | – | UserManagementSection "Purge manual grants" |

### Articles (`articles.ts`)
| `GET /api/articles/:resource` | – | ArticleWorkspace rail |
| `GET /api/articles/:resource/unit` | – | ArticleEditor load |
| `PATCH /api/articles/:resource/unit` | Yes | ArticleEditor Save |
| `POST /api/articles/:resource/unit/validate` | – | ArticleEditor Approve/Unapprove |
| `POST /api/articles/populate` | – | ArticleWorkspace "Populate from books" |
| `POST /api/articles/:resource/add` | – | ArticleWorkspace "Add [query]" |

### Templates (`templates.ts`)
| `GET /api/templates/` | – | TemplateWorkspace rail |
| `GET /api/templates/unit` | – | TemplateEditor load |
| `PATCH /api/templates/unit` | Yes | TemplateEditor Save |
| `POST /api/templates/unit/draft` | – | TemplateEditor/bulk "Draft with AI" |
| `POST /api/templates/unit/validate` | – | TemplateEditor Approve/Unapprove |
| `GET /api/templates/unit/history` | – | TemplateHistoryDialog |
| `POST /api/templates/sync` | – | [INFERRED — sheet re-sync, likely an internal/admin-triggered maintenance route, no UI call site traced] |

### Translation memory (`translationMemory.ts`)
| `GET /api/translation-memory/prefs` | – | Brief / Instructions / Common-issues load |
| `PUT /api/translation-memory/prefs` | Yes | Brief / Instructions / Common-issues Save |
| `GET /api/translation-memory/terms` | – | Terminology list |
| `POST /api/translation-memory/terms` | – | Terminology Add term / Add rendering |
| `PATCH /api/translation-memory/terms/:id` | Yes | Terminology row edit Save |
| `DELETE /api/translation-memory/terms/:id` | – | Terminology row Delete |
| `GET /api/translation-memory/terms/export` | – | Terminology Export (CSV download) |
| `POST /api/translation-memory/terms/import` | – | Terminology Import (preview + apply) |
| `GET /api/translation-memory/terms/count` | – | [INFERRED — badge/count support, not directly traced to a render site] |
| `GET /api/translation-memory/examples` | – | Examples section list |
| `GET /api/translation-memory/export-status` | – | Context-pack status chip (Preferences rail header) |

### L10n (`l10n.ts`)
| `GET /api/l10n/overrides` | – | Localization editor load |
| `PUT /api/l10n/overrides/:lang` | Yes | Localization editor Save; LocalizationInspector inline edit |

---

## Notes on completeness / confidence

- Every citation above traces to a direct `Read` of the named file by one of five parallel research passes (Setup/Import/Preferences; AI pipeline + status; Notes/Questions/Words; Scripture editing + alignment; Templates/Articles/Shell chrome), reconciled by hand, plus a direct read of `App.tsx` and a full repo-wide grep of every `app.route(...)` mount and every `.get/.post/.put/.patch/.delete(...)` registration in `api/src/*.ts` (excluding `.test.mjs` files) for the handle registry.
- **Not read in full in this pass** (flagged so a follow-up doesn't assume coverage): `Shell.tsx` beyond ~1200 of its ~4000+ lines (state/handlers were grepped, not the full JSX render tree — the exact `<TopBar/>` prop-passing call site, the Board/dual-aligner dialog mount wiring, and any Shell-only chrome not surfaced through a child component's props are unconfirmed); `TimelineRail.tsx` (only type-checked via grep, not read — the exact trigger for `ChapterBoard` is unconfirmed); `VerseHistoryDialog.tsx`'s internal control set (only its call-site contract was traced); `ResourceColumn.tsx` beyond its first ~400 lines; `lib/chapterCopy.ts` and `lib/exportUsfm.ts` (button-level contract only); non-English locale files (only `en.json` copy was used); `api/src/*.ts` route **handler bodies** (route registrations were grepped for the handle registry, but request/response shapes for a handful of routes were inferred from `sync/api.ts`'s client-side types rather than re-verified against the server implementation).
- Every row marked **[INFERRED]** in the handle registry is a route confirmed to exist via the server-side grep but whose frontend call site was not directly traced in this pass — these are candidates for a follow-up verification pass, not confirmed-absent or confirmed-unused.
- Two known gaps flagged explicitly by the research passes as findings, not assumptions: (1) the "5-pipeline-menu-plus-macro" premise in the task brief does not match the code — only 5 items exist today (3 base + 2 translate-mode), and the macro mechanism is scaffolded but unwired; (2) `PipelineErrorKind` values (including `interrupted`) have no i18n/friendly-copy mapping anywhere and reach the user as raw enum strings in the K.1 completion toast.
