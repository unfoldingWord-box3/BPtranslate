# UX simplification: book lifecycle + app-wide click economy

> **Status: DESIGN DOC for review — scoping, not final UX.** Deliverable for
> issue [#290](https://github.com/unfoldingWord-box3/BPtranslate/issues/290),
> extended per the follow-up ask to step back and audit **every** click sequence
> at **every** screen size. Part 1 delivers #290's book-lifecycle scoping;
> Part 2 is the app-wide audit; Part 3 is the PR-sized breakdown for both.
>
> **Relation to draft PR #294** (`docs/book-lifecycle-flow.md`): that draft maps
> the same seven-stop flow and reaches the same three-stop direction. This doc
> supersedes it — it keeps #294's structure but **corrects its central technical
> claim** (the #236 fix cannot be a pair-level re-key on `updated_by`; export
> already has a row-level review gate, and the durable fix is making that gate
> provenance-aware — §1.4) and adds the app-wide audit #294 doesn't cover.
> Recommend closing #294 in favor of this doc.

---

## Part 1 — Book lifecycle (issue #290)

### 1.1 Current flow: seven stops

Stops marked **[ACCIDENTAL]** are plumbing artifacts, not translation work.

| # | Stop | Screen | Behind it |
|---|------|--------|-----------|
| 1 | **[ACCIDENTAL]** Set per-chapter source overrides | Admin → Setup | `AdminSetupScreen.tsx:188-248` hosts `BookSourceOverridesPanel.tsx`; writes `book_source_overrides` via `PUT /api/books/:book/sources` (`bookImport.ts:153-260`). Config lives two screens from the import it configures; the admin must re-pick the book from a 66-entry select. |
| 2 | Import the book | Books | `BooksScreen.tsx:366-644` detail panel → `POST /api/books/:book/import` (`bookImport.ts:262-426`). Range overrides only take effect on a **full** import (`bookImport.ts:132-137`); re-pull (`/reimport`) never applies them (`bookReimport.ts:2802-2823`). |
| 3 | AI-translate | editor | Translate screens + `/api/tn-quick`, `/api/pipelines/*`. |
| 4 | Approve / edit rows | review queue | `ReviewQueue.tsx` → `POST /api/rows/{tn,tq}/:id/validate` (`rows.ts:1158-1210`); `translation_state` → `validated`. |
| 5 | **[ACCIDENTAL]** Return to Setup to **remove** override rows | Admin → Setup (again) | Deleting rows from `book_source_overrides` is the only in-app way to clear the export hold-out — provenance used as a publish button. |
| 6 | **[ACCIDENTAL]** Run a scoped export | Admin → Workflow | `AdminWorkflowScreen.tsx:1236-1268` "Run export now" dialog with book scope (#287) → `POST /api/exports/run`. Org-wide screen, not the book. |
| 7 | Merge the Door43 PR by hand | Door43 | `ExportWorkflow` opens a per-`(book,resource)` contributor-branch PR (`{BOOK}-be-{users}`, `export.ts:56-63`); merge is manual (`VALIDATORS = []`, `postExport.ts:45`, disabled 2026-05-21). |

### 1.2 The mechanism behind stop 5

Export assembles a held-out set of `"BOOK:resource"` keys
(`exportWorkflow.ts:268-290`) from two sources — whole-book provenance markers
(`book_imports.*_source`, via `heldOutNoteResources`, `dcsSources.ts:267-287`)
and range overrides (`listRangeHeldOutKeys`, `bookSource.ts:479-497`) — and
**skips the whole pair** (`exportWorkflow.ts:353-376`, snapshot reason
`held_out:<resource>` since #236's visibility fix). It is a whole-RESOURCE
skip, so a partial book's *owned* chapters don't publish either (documented
limitation, `exportWorkflow.ts:264-267`).

### 1.3 Proposed flow: three stops, the book page owns the lifecycle

| # | Stop | What the book page does |
|---|------|-------------------------|
| 1 | **Bring in this book** | On the book card / package hub: an inline source sheet asks, per resource (and optionally per chapter-range), where content comes from — **own repos** (default), **unfoldingWord upstream** preset (#289 / PR #291), **Aquifer** (tn), or **another Door43 URL** — then writes `PUT /sources` + `POST /import` in one flow. Folds stops 1+2. |
| 2 | Draft + review | Editor + review queue, unchanged (stops 3+4). |
| 3 | **Publish this book** | Button on the book page: readiness rollup → `POST /api/exports/run {book}` (#287 plumbing) → surfaces per-resource results and the Door43 **PR links** (`pr_number` is already stored and listable, `exports.ts:83-110`). Stops 5+6 disappear. |

UI placement (sketch, not final):

- **`#/package/{book}`** (`PackageHubScreen.tsx`) gains a **lifecycle header
  card**: status (not imported / imported / N of M approved / published, PR
  links), with "Bring in this book" before import and "Publish this book"
  after. It currently has **zero** lifecycle actions and deliberately no
  progress bar because there is no book-level rollup endpoint
  (`PackageHubScreen.tsx:43-52` names the fix: grow `GET /api/chapters/{book}`
  with per-chapter `tnValidated` / `tqValidated` / `versesDone`). That endpoint
  is a prerequisite for both the readiness indicator and honest progress.
- **`#/books`** (`BooksScreen.tsx`) keeps its import affordance but the Import
  button opens the same inline source sheet instead of firing blind. Today's
  panel imports with **no** source question and points at Admin → Setup via a
  "moved to…" caption (`BooksScreen.tsx:597-603`) — that pointer is the smell
  this design removes.
- The Setup panel survives as the *edit-after-import* path (or retires once
  the sheet can edit ranges too); either way the config's **home** is the book.
- The 409 `has_local_edits` flow gets a real UI: today the client surfaces the
  count with **no override affordance** (`BooksScreen.tsx:429-443`) while the
  API's `force` + `confirmDiscardEdits` path (`bookImport.ts:288-335`) is
  API-only. The sheet should offer the explicit, scary, admin-only confirm.

### 1.4 The durable #236 fix — corrected to row level

Provenance does two jobs today: **(a) reimport guard** (don't clobber
cross-sourced/AI rows with pristine master content) and **(b) export
publish-permission** (hold the pair out). Job (b) forces stop 5.

**Correction to PR #294's framing.** "Key publish-permission on approved/edited
rows" cannot be a pair-level re-key, and `updated_by` is the wrong signal.
What actually exists:

- Export **already gates per row on review state**: `gateTsvRowForExport`
  (`preDraftSnapshot.ts:62-77`, applied at `exportWorkflow.ts:1583-1608`)
  substitutes the `pre_draft_json` snapshot (last *published* content) for any
  `ai_draft` **or** `edited` row — only `validated` (or never-drafted) rows
  export live content. Unapproved AI content already never reaches DCS.
- The gate is **not provenance-aware**, and that is the real reason the blunt
  pair-level hold-out exists: foreign-sourced rows would leak through it.
  DCS-range rows (e.g. en_tn ch13-16) import **pristine** — `translation_state`
  NULL → gate says "current" → English text would export. Aquifer rows import
  as `ai_draft` with no meaningful snapshot (`bookImport.ts:1346-1379`) → gate
  says "legacy" → Aquifer text would export.

**The fix, precisely:** make the row-level gate provenance-aware and drop the
pair-level skip (for tn/tq):

```
publishable(row) :=
  translation_state = 'validated'                          → export live content
  translation_state IN ('ai_draft','edited') AND snapshot  → export snapshot   (unchanged)
  pristine AND own-provenance                              → export live content (unchanged)
  pristine-or-draft AND foreign-provenance, no snapshot    → OMIT the row       (new)
```

"Foreign-provenance" is computable per row from the same data the hold-out
uses today: the whole-book marker + the range table resolved to a chapter set
(`heldOutChapters`, `bookSource.ts:442-457`) — provenance stays as metadata
and as the reimport guard (`isPristineTsv`, `bookReimport.ts:1245-1254`),
exactly as #294 says.

Consequences worth stating:

- **Stop 5 is deleted** — nothing to un-configure before publishing.
- **Partial books publish their approved chapters.** #294's "optional PR 6"
  (row/range-granular publish) is not a stretch goal; it is the *same change*.
  A pair-level re-key would just move the cliff, not remove it.
- **Shrink-guard interaction is safe but must be documented.** Omitted foreign
  rows were never in the org's master for translate-mode bootstraps (clean 404
  → `bootstrap_new_file`, allowed, `exportWorkflow.ts:1930-1935`). For a
  re-translate over a **populated** master, omitting many non-validated rows
  will trip `exportTsvShrinkRefused` (>25 rows and >5%, `export.ts:200-202`) —
  that is the guard working as designed: publish when review is substantially
  done, or use the admin `shrinkOverride`.
- **Observability shape survives**: the `held_out:` snapshot reason becomes a
  per-resource `held_for_review: N rows` count so admins still see why content
  is absent (#236's visibility ask, already shipped, gets repurposed).
- **Scope: tn/tq only.** `twl_rows` and `verses` have **no**
  `translation_state` (`0001_init.sql`, confirmed at `bookImport.ts:300-313`);
  scripture/twl keep the whole-book provenance hold-out until they grow a
  review concept (relates to #104's progress/PM layer — `verse_lane_checks`
  is per-user checkoff, not approval, and auto-reopens on edit,
  `laneReopen.ts:52`).

### 1.5 Guards that must survive

Orthogonal to the publish-permission change; all preserved.

| Guard | Protects against | Where |
|-------|------------------|-------|
| Shrink guard | A render that mass-deletes rows/files vs. master | `exportWorkflow.ts:1913-1944` (TSV), `:1149-1180` (alignment), `:1424-1443` (articles); policy `export.ts:200-202` |
| Freshness gate | Committing a render while D1 is stale vs. master; fails **closed** on unfetchable master SHA | `exportWorkflow.ts:1082-1118`, `checkMasterFreshness :2032-2089` |
| Pristine-row sync | Pre-export DCS→D1 sync touches only pristine rows; batched (`WRITE_BATCH = 90`) under the ~1000-subrequest cap | `exportWorkflow.ts:292-328`, `bookReimport.ts:2966+` |
| Contributor-branch policy | Never a direct push to master; per-`(book,resource)` `-be-` branch (suffix is load-bearing for DCS-side gates) + human-merged PR | `export.ts:41-63`, `exportWorkflow.ts:1208-1288` |
| Provenance-as-reimport-guard | Nightly reimport clobbering cross-sourced/edited rows | `bookReimport.ts` pristine predicate + held-out chapter skip `:2802-2823` |

---

## Part 2 — App-wide click economy audit

Method: full read of routing (`App.tsx`), both nav systems, all flow screens,
classic workspaces, and every `useMediaQuery` call site. Findings are the
facts; the fix column is the smallest change that removes the friction.

### 2.1 Structural: the app has three nav systems and a route-arity trap

| Finding | Evidence | Smallest fix |
|---|---|---|
| **Three parallel navigation chromes** (FlowNav pill bar, AdminDesk rail, bare back-chevron screens) plus classic TopBar — and two screens with none. | `FlowNav.tsx`, `AdminDesk.tsx`, `PackageHubScreen.tsx:350`, `Shell.tsx` | Pick one chrome for the redesign surfaces; give chevron-only screens the global strip. |
| **Route arity silently picks which editor you get**: `#/scripture/JON/2` → redesign, `#/scripture/JON/2/3` → legacy flow screen; same for words/align. FlowNav links to the **legacy** 3-segment forms (`FlowNav.tsx:57-61`) while Books→Package lands in the redesign — two editors for the same verse, no indication which you're in. | `App.tsx:203-248` | Point FlowNav at the redesign routes; make legacy arities redirect. |
| **Duplicate surfaces**: `#/setup` and `#/admin/setup` mount the same `SetupWizard`; `#/team`/`#/admin/team` likewise; `ImportWorkspace` (`#/import`) duplicates BooksScreen's import *and* still embeds the overrides panel that Books says "moved to Admin → Setup". | `App.tsx`, `ImportWorkspace.tsx:472-484` | Redirect the duplicates; delete `ImportWorkspace` once the source sheet lands (Part 1). **Done for `ImportWorkspace`:** deleted, `#/import[/BOOK]` → `#/books[/BOOK]`. `#/setup` / `#/team` duplicates remain. |
| **The review queue is a dead end**: `#/review` renders classic TopBar with navigation off and **no route back to Books or Home** — only More-menu items and `#/preferences`. The avatar shows "?" and Sign out is a no-op (no `username`/`onLogout` passed). This is the primary approval destination — Home's tN and tQ queue cards both point here. | `App.tsx:760-761`, `ReviewQueue.tsx:1222`, `TopBar.tsx:212-221,1035,1086`, `HomeScreen.tsx:451,461` | Give ReviewQueue the flow chrome (or at minimum a back-to-package chevron). |

### 2.2 Journey friction (desktop)

| Journey | Today | Friction / fix |
|---|---|---|
| Cold start → editable chapter | 4-5 clicks (tile-select → Open → expand surface card → chapter) | Book tile click should navigate, not just select. Continue card's two buttons land at different depths (package hub vs. a specific verse's *notes*); add a same-depth scripture resume. `resolvedLastPosition` is computed in 3 places with 3 fallback ladders (`App.tsx:880`, `BooksScreen.tsx:710`, `HomeScreen.tsx:148`) — unify. |
| Edit a note, keep it | **Impossible without approving.** `TranslateNotesScreen` action bar is Redo / Not needed / Approve — `saveDraft()`'s only caller is inside `handleApprove` (`TranslateNotesScreen.tsx:819,1554-1610`; same on Questions `:773`). Unready edits live only in browser IndexedDB. | Add Save draft (scripture screen already has Save + Approve, `TranslateScriptureScreen.tsx:1025-1061`; ReviewQueue has Undo/Save/Approve). |
| Chapter AI pipeline | 4-6 clicks, **chapter entered twice** (AiScreen's own book/chapter fields at `AiScreen.tsx:394-412`, then re-entered in `PipelineMenu`'s dialog `refInput`, re-seeded on open `PipelineMenu.tsx:255`), up to two confirms. Whole-book AI translate on BooksScreen dispatches one job per chapter with **no confirm** (`BooksScreen.tsx:450-480`) — inverted risk gating. | One ref input; confirm the big action, not the small one. |
| Approve AI rows | No filter of any kind in ReviewQueue — `ai_draft` is detected on the notes screen (`TranslateNotesScreen.tsx:964`) but not here; state shown as an 8px dot (`ReviewRail.tsx:220-233`). "Approve all notes (N)" has no subset selection and runs a **sequential per-row loop** that stops at first failure (`ReviewQueue.tsx:737-771`) — 80 notes = 80 serialized round-trips behind one unconfirmed click. | Add state filter + a bulk validate endpoint. |
| Switch surface, same chapter (notes ↔ questions ↔ scripture) | 3 clicks via package hub, re-expanding the chapter list each time (`PackageHubScreen.tsx:194-215`). | Lateral surface tabs on the translate screens. |
| Previous chapter | **No control exists** in the redesign — next-chapter only (`TranslateScriptureScreen.tsx:1311-1324`, Notes `:1152`, Questions `:1156`). Going back = URL surgery or 3 clicks. | Symmetric prev/next (classic TopBar already has it, `TopBar.tsx:695-770`). |
| Keyboard | **Two shortcuts in the whole app**, both off the default path (arrow keys on legacy `VerseScreen.tsx:280-293`; Ctrl+F in classic `ScriptureColumn.tsx:273-280`). No Cmd+S, no approve-and-advance. | Add Save/Approve+advance and chapter nav keys to the translate screens. |
| Set source overrides | Leave the book, land on the longest admin page, re-pick the book from a 66-entry select seeded with `me.lastBook` (the last *edited* book, not the one you were looking at — `AdminSetupScreen.tsx:348`). | Part 1's source sheet. |
| Run export / see result | Two rail destinations: run on `#/admin/workflow`, history on `#/admin/observe` (read-only, `adminSurfaceMap.ts:144`). | Part 1's Publish button shows its own results; Workflow keeps the org-wide view. |
| Verse status | Three mechanisms, three confirm policies: side effect of Approve verse; one-click rail checkboxes; Board bulk with double confirm. Accidentally hiding a lane (click its header letter, `TimelineRail.tsx:146-175`) is only undoable from the Board dialog. | Consolidate under the progress rollup work (Part 1 prerequisite). |

### 2.3 Confirm-policy inconsistency

Admin → Workflow confirms **every** mutating verb by design
(`AdminWorkflowScreen.tsx:57,439`); meanwhile whole-book AI translate,
override removal (`BookSourceOverridesPanel.tsx:214`), and Approve-all are
unconfirmed one-clicks. Policy should follow blast radius, not screen: confirm
job-fanout and destructive bulk actions everywhere, drop confirms on
single-row reversible ones.

### 2.4 Small screens

Bands: phone <560, tablet 560-899, desktop ≥900 (`useLayoutBand.ts:15-25`).
The two nav systems collapse at **different widths** (FlowNav at 700,
AdminDesk at 900), so between 700-900 the chrome is half-collapsed.

| Surface | Problem at phone width | Fix |
|---|---|---|
| `PreferencesWorkspace` / ~~`ImportWorkspace`~~ (deleted) / `TemplateWorkspace` | Hard-coded 240-280px `flexShrink:0` rails, zero media queries — rail eats 64-75% of a 375px viewport | Collapse rail to a drawer (or delete `ImportWorkspace`, §2.1). |
| ReviewQueue | Rail dropped on phone (`ReviewQueue.tsx:1282`) and **Approve-all lives in the rail** (`ReviewRail.tsx:119`) — bulk approve unreachable on phones | Move bulk action into the `FlowActionBar`. |
| Classic Shell | Phone shows one region (scripture *or* resources, `WorkspaceLayout.tsx:320-326`); Timeline rail force-collapsed with its toggle removed (`Shell.tsx:497,3828`) — per-verse lane check-off has **no mobile affordance** | Lane check-off needs a home in the translate screens' action bar. |
| AdminSetupScreen | Section jump strip hidden below `md` (`AdminSetupScreen.tsx:304`) on the longest admin page | Keep the strip as horizontally scrollable chips. |
| BooksScreen | Below 560px: two-level accordion + detail panel renders **below the whole canon tree** — first tap has an off-screen effect; ~7 taps + a long scroll to open a book | Tile tap navigates (§2.2 fix covers this); detail panel becomes a bottom sheet. |

The `Translate*` family + PackageHub adapt cleanly (master-detail at `md`,
44-50px targets, `useSwipeNav`, safe-area insets) — the best-adapted screens
are exactly the ones with no nav chrome, which is why fixing §2.1 pays twice.

---

## Part 3 — PR-sized breakdown

**Track A — book lifecycle (#290), ordered, independently shippable:**

- **A1. Provenance-aware row-level publish gate (the durable #236 fix).**
  Extend `gateTsvRowForExport` per §1.4; delete the tn/tq pair-level skip;
  repurpose `held_out:` observability to per-row held-for-review counts. Keep
  all §1.5 guards. Backend-only; deletes stop 5 before any UI moves. Includes
  #294's "optional PR 6" by construction.
- **A2. Book-level rollup endpoint** — grow `GET /api/chapters/{book}` with
  `tnValidated`/`tqValidated`/`versesDone` per chapter
  (`PackageHubScreen.tsx:43-52`; indexes from 0037/0038 make it cheap).
  Unblocks readiness + progress UI.
- **A3. "Bring in this book" source sheet** on BooksScreen/PackageHub: per
  resource own-repos / uW-upstream (#289 — land PR #291 first and reuse
  `upstreamSourceForResource`) / Aquifer / URL, optional chapter ranges;
  writes `PUT /sources` then imports; surfaces the `has_local_edits` 409 with
  an explicit admin confirm. Retires the Setup placement (keep panel as edit
  path initially) and deletes `ImportWorkspace`. *(Shipped in PR #305, except the
  `ImportWorkspace` deletion, which is the follow-up.)*
- **A4. "Publish this book"** on the package hub lifecycle card:
  `exportsRun({book})`, per-resource results, Door43 PR links from
  `pr_number`, readiness from A2.
- **A5. Post-#282 cleanup:** close draft **PR #285** (superseded by merged
  #286) and draft **PR #294** (superseded by this doc); land **PR #291**.

**Track B — click economy (independent of Track A):**

P0 (small diffs, high daily-use payoff):
- **B1.** Save-draft button on Notes/Questions screens (§2.2 — data-safety
  adjacent: server persistence currently requires approving).
- **B2.** Previous-chapter control + lateral surface tabs on translate screens.
- **B3.** ReviewQueue: flow chrome / back route + move Approve-all into the
  action bar (fixes the phone gap too) + a translation-state filter.
- **B4.** Book tile tap navigates; unify `resolvedLastPosition`.

P1: **B5.** FlowNav → redesign routes + legacy-arity redirects; **B6.** single
ref input in the AI pipeline flow + confirm on whole-book AI translate;
**B7.** bulk validate endpoint behind Approve-all.

P2: **B8.** collapse/delete the fixed-rail classic workspaces; **B9.** keyboard
layer (save/approve-advance, chapter nav); **B10.** confirm-policy pass per
§2.3; **B11.** align the two nav collapse breakpoints.

**Success check (#290):** met after A1+A3+A4 — an admin takes a mixed-source
book from not-imported to a Door43 PR visiting only the book page, the editor,
and the review queue.

---

## Cross-references

- **#236** — provenance-as-publish-permission; durable fix is A1 (§1.4), which
  also resolves its "tracking" ask (translated notes for translate-mode books
  gain a publish path once validated).
- **#282 / PR #286** (merged) — full-canon picker; placement fixed by A3.
  **PR #285** superseded → close.
- **#287** — book-scoped export plumbing reused by A4.
- **#289 / PR #291** — uW-upstream preset, reused inside A3's sheet.
- **#104** — the review-state publish gate and A2's rollup are the natural
  seams a future PM layer (assignments, approval gates) plugs into; scripture
  approval (twl/verses) is deliberately deferred to that scoping.
- **PR #294** — prior draft of Part 1; superseded (see header).
