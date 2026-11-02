# AI Pipeline Integration — Data Explainer

**Audience:** A Claude session working inside [`unfoldingWord/bp-assistant`](https://github.com/unfoldingWord/bp-assistant) or [`unfoldingWord/bp-assistant-skills`](https://github.com/unfoldingWord/bp-assistant-skills), reading cold. By the end of this doc you should be able to propose a concrete API contract back to the `bible-editor` side.

**Status:** Historical contract/explainer. The recommended trigger + poll +
Door43 pull shape has since been implemented on the `bible-editor` side with
D1-backed queueing, status polling, and auto-apply of completed pipeline output.
Use this doc for background and partner-contract context, not as a current
"no code exists" statement.

**Update (2026-11, #470):** the editor no longer offers the bot's three original
pipelines ("Generate ULT + UST", "Write translation notes", "Write translation
questions"). The only AI pipeline the editor starts is `translate` (tN and tQ for
a chapter, plus tW/tA articles), which runs on the organization's own AI key. The
server still knows the old `generate` / `notes` / `tqs` types so job history can
show past runs, and `/api/pipelines/start` refuses them (#551).

---

## 1. Who's who

**`bible-editor`** (this repo) is a 7-month tactical replacement for gatewayEdit + tcCreate — a browser-based editor for translation notes (TN), questions (TQ), word links (TWL), and aligned ULT/UST/UHB/UGNT verse text. It's a React/Vite SPA backed by a Cloudflare Worker + D1 SQLite + R2. Source of truth during a session is **D1**, not DCS; DCS is touched once per night via a Workflow that commits a snapshot.

**`bp-assistant`** is the unfoldingWord AI pipeline — a Zulip-triggered bot on Fly.io (`uw-bt-bot`) that runs Claude-Code-driven skill pipelines (ULT/UST generation, tn-writer, tq-writer, alignment) and commits results to Door43 via a deterministic `repo-insert` step.

**The integration problem:** `bible-editor` is replacing the tools (gatewayEdit, tcCreate) that translators currently use to edit pipeline output. So we need to trigger pipelines from `bible-editor` and consume their output **mid-session**, at chapter scale, with run times of ~1 hour.

We already have one piece of this working: the single-note `tn-quick` proxy. The new scope is roughly three orders of magnitude bigger.

---

## 2. `bible-editor` data architecture

### Stack

- **Frontend:** React 18 + Vite + TypeScript + MUI. Single-page app served by the Worker's asset binding.
- **API:** Cloudflare Workers (Hono framework, TypeScript).
- **Data:** D1 (SQLite at the edge) for relational data; R2 for snapshot exports; IndexedDB on the client for an outbox.
- **Workflow:** Cloudflare Workflows for the nightly DCS export.

### D1 schema (selected)

See [api/migrations/0001_init.sql](../api/migrations/0001_init.sql). Row shapes in [api/src/types.ts](../api/src/types.ts).

| Table | Purpose |
|---|---|
| `verses` | ULT/UST/UHB/UGNT verse text, keyed by `(book, chapter, verse, bible_version)`. `content_json` stores parsed usfm-js. |
| `tn_rows` | Translation notes — sticky 4-char `id`, `(book, chapter, verse)`, `support_reference`, `quote`, `note`. |
| `tq_rows` | Translation questions — `question`/`response`. |
| `twl_rows` | Word links — `orig_words`, `tw_link`. |
| `verse_statuses` | Per-verse done/not-done flag. |
| `edit_log` | Append-only audit trail of mutations. |
| `users`, `sessions` | DCS-OAuth identities + signed-in sessions. |
| `book_imports`, `export_snapshots` | Import/export bookkeeping. |

Every row has an integer `version`. Optimistic concurrency: mutations send `If-Match: <version>`; conflicts return 409 and re-queue against the server's current version.

### Sync model

Edits never block on the network:

1. User edits in the browser → optimistic local apply.
2. Patch is enqueued to an IndexedDB outbox ([web/src/sync/outbox.ts](../web/src/sync/outbox.ts)).
3. Background drain posts to the Worker FIFO with exponential backoff; survives crashes.
4. Worker writes to D1, appends to `edit_log`.

Reads are on demand: navigate to a chapter → `GET /api/chapters/:book/:chapter` → render. In-app row/verse changes also broadcast over the ChapterRoom WebSocket. There is still no general-purpose subscription to arbitrary external DCS changes.

### Auth

DCS OAuth or local dev sign-in starts a cookie session: HttpOnly Access/Refresh
cookies plus a non-HttpOnly CSRF cookie. Writes require a valid session and a
matching `X-CSRF-Token`; browser code never stores the JWT in localStorage. See
[api/src/auth.ts](../api/src/auth.ts).

### Export

Cloudflare Workflow at 06:00 UTC: for each `(book × resource)`, render TSV or
USFM from D1, stage to R2, and (if `DCS_SERVICE_TOKEN` is set) commit to the
configured DCS owner on a generated per-book contributor branch. See
[api/src/exportWorkflow.ts](../api/src/exportWorkflow.ts).

### Key consequence for integration

> `bible-editor` now has an inbound path for editor-triggered AI pipeline
> output: on a `done` poll, the Worker fetches the Door43 raw URLs, stages the
> parsed rows, and auto-applies them to D1 under the chapter-lock model. General
> external DCS edits still require explicit reimport tooling.

---

## 3. Current AI integration: `tn-quick`

This is the only existing AI surface in `bible-editor` and the obvious reference point.

**Trigger:** Sparkles button in [NoteCard.tsx](../web/src/components/NoteCard.tsx) (PR #5). Becomes active when the user has selected a support reference and typed text in the Quote field.

**Request assembly:** [tnQuickRequest.ts](../web/src/lib/tnQuickRequest.ts) — detects Hebrew vs English mode via the verse's `\zaln-s` alignment milestones, gathers ±5-verse context for both ULT and UST, packages a `TnQuickRequest`.

**Proxy:** [api/src/tnQuick.ts](../api/src/tnQuick.ts) — Worker validates JWT, swaps the user's Authorization header for the shared `BT_API_TOKEN`, forwards to `https://uw-bt-bot.fly.dev/api/tn-quick` (= `bp-assistant/src/api/tn-quick.js`).

**Latency:** Seconds. Synchronous fetch with an `AbortController` keyed to component lifetime. Stale completions are silently dropped if the user navigates away.

**Persistence:** Response is shown in a confirmation dialog. On accept, the quote + note fields are stashed and flushed through the outbox like any other edit.

**What does not generalize:** Per-call scope is one note. Driving "all notes for this chapter" would mean N synchronous round-trips, each subject to its own model latency. Driving "generate ULT + UST + notes + tQs for chapter N" needs a fundamentally different shape.

---

### 3.1 Chapter-range UX (client-side fan-out, 2026-05-14)

The `PipelineMenu` confirmation dialog now exposes an editable chapter reference (`PSA 130` by default, accepts `PSA 130-135` or `130-135`). For multi-chapter ranges the client **fans out N single-chapter `POST /api/pipeline/start` calls**, one per chapter, sequentially. Each call uses `startChapter === endChapter`. Rationale:

- bp-assistant pipelines are documented as single-chapter scope (§4 below) and we don't know whether the upstream actually honors `endChapter > startChapter`.
- Per-chapter fan-out reuses the existing chapter-lock, conflict, and status-pill plumbing without bp-assistant changes.
- Visibility: each chapter shows up as its own job in the status panel.

**Future direction (bp-assistant could add):** native range support — accept one `POST /api/pipeline/start` with `endChapter > startChapter`, hold a single lock for the whole range, share model context across adjacent chapters. Response shape is already compatible (`{ jobId, scope: { book, startChapter, endChapter }, status }`). When that lands, swap the fan-out for a single call.

## 4. The new requirement

We want translators to trigger, from inside `bible-editor`, the same pipelines `bp-assistant` already runs from Zulip:

| Pipeline | Output | Scope | Typical latency |
|---|---|---|---|
| `makeBP` | Full book-package for a chapter | 1 chapter | ~1 hour |
| `ULT-gen` + `ULT-alignment` | Aligned ULT chapter | 1 chapter | minutes |
| `UST-gen` + `UST-alignment` | Aligned UST chapter | 1 chapter | minutes |
| `tn-writer` (+ `parallel-batch`) | TN TSV for a chapter | 1 chapter | tens of minutes |
| `tq-writer` | TQ TSV for a chapter | 1 chapter | tens of minutes |

**Output volume per chapter:** 20–200 aligned verses + 50–500 notes + tQs.

**User experience expectations during the wait:**
- The user does not sit and watch a spinner for an hour. They keep working — probably in a different chapter or book.
- They need visibility into pipeline status without leaving the editor.
- When output lands, they should be able to bring it into the editor without losing in-progress work.

---

## 5. What `bp-assistant` already has that we can leverage

Surfacing these so the proposal back is grounded in existing scaffolding, not greenfield:

- **Checkpoint state machine.** [`src/pipeline-checkpoints.js`](https://github.com/unfoldingWord/bp-assistant/blob/main/src/pipeline-checkpoints.js) — file-backed JSON, keyed by `sessionKey` + `pipelineType` + `scope (book, startChapter, endChapter, …)`. Atomic write-then-rename. Today there's no built-in HTTP query layer beyond `listCheckpoints()`.
- **Health endpoint reporting active pipelines.** `GET /health/pipelines` already surfaces "currently running checkpoints" for the deployment-locking workflow. This proves an HTTP surface for status exists; it just isn't general-purpose yet.
- **`POST /api/tn-quick` precedent.** [`src/api/tn-quick.js`](https://github.com/unfoldingWord/bp-assistant/blob/main/src/api/tn-quick.js) is the existing per-note HTTP endpoint authenticated by `BT_API_TOKEN`. New pipeline-trigger endpoints can follow the same shape.
- **`api-runner/` scaffold.** `src/api-runner/api-pipeline.js`, `runner.js`, `agent-loop.js`, `cli.js` — suggests the team has already started a non-Zulip programmatic invocation path. This is probably where chapter-scale endpoints belong.
- **MCP server on :3001.** `src/mcp-server.js` uses `StreamableHTTPServerTransport`, bearer-token auth (`BT_MCP_API_TOKEN`), `MCP_BIND_HOST=127.0.0.1` by default. Current tools are reference-data (`get_verse_data`, `get_existing_notes`, `get_template`, `curate_published_data`), used by Claude *during* a pipeline. It is not currently a public surface and the existing tools don't trigger pipelines, but it could grow that direction.
- **Door43 push is already deterministic.** `repo-insert` skill + `src/door43-push.js` + `repo-verify.js` already commit pipeline output to Door43 via the Gitea API. This is the natural delivery channel for chapter output — we don't need to invent a new one.

---

## 6. Integration options

Four shapes, with tradeoffs. Recommendation in §7.

### A. HTTP trigger + poll + DCS pull (recommended)

```
bible-editor Worker  --POST /api/pipeline/start-->  bp-assistant
                                                       │
                              (Claude SDK runs skill, ~1h)
                                                       │
                                                  repo-insert
                                                       │
                                                       ▼
                                                     Door43
                                                       ▲
                                                       │
bible-editor Worker  <--poll GET /api/pipeline/:job-- bp-assistant
                     |
                     └── on "done": pull chapter from Door43 → D1
```

`bp-assistant` exposes two new endpoints alongside `/api/tn-quick`:
- `POST /api/pipeline/start` → `{ jobId, pipelineType, scope }`
- `GET /api/pipeline/:jobId` → checkpoint state + Door43 ref where output landed

Output continues to flow to Door43 via existing `repo-insert`. `bible-editor` polls; on completion, **pulls the chapter from Door43 into D1** via a new inbound-import path that we'd build on this side.

**Pros**
- Smallest delta in `bp-assistant`: one endpoint pair + a thin checkpoint-to-JSON serializer. Fits the `api-runner/` scaffold.
- Reuses the existing `repo-insert` → Door43 path. Single source of truth for pipeline output.
- Forces `bible-editor` to build inbound-from-DCS, which we'll need regardless (re-baselining a book, ingesting external edits, recovering from corruption).
- Zulip-triggered and editor-triggered pipelines have identical downstream flow.

**Cons**
- `bible-editor` must design conflict resolution: what happens when output lands while the user is editing the same chapter?
- DCS round-trip adds latency on top of the pipeline run itself (probably negligible at 1 hour total).

### B. HTTP trigger + bundled output (skip DCS)

Same trigger endpoint, but the status endpoint returns the generated USFM/TSV directly. `bible-editor` writes straight to D1 without going through Door43.

**Pros**
- No DCS round-trip.
- No new inbound-from-DCS plumbing.

**Cons**
- Two output paths in `bp-assistant`: Zulip→DCS vs editor→inline. Tempts divergence between them.
- Either we (a) disable DCS push for editor-triggered runs (bad — DCS goes stale relative to D1's nightly export), (b) do both (race condition, double-counted edits), or (c) accept that editor-triggered pipelines bypass Door43 (loses the public-history-of-AI-changes benefit).
- We still need a polling pattern; HTTP can't hold a connection for an hour.

### C. MCP transport

`bp-assistant` exposes pipeline-trigger tools via the existing MCP server. `bible-editor`'s Worker becomes an MCP client.

**Pros**
- Claude-native protocol; consistent with `bp-assistant`'s internal patterns.
- Could share auth/transport with other Claude clients that want to drive pipelines.

**Cons**
- `bible-editor` isn't a Claude application; it's a Worker calling a REST endpoint. Adding MCP-client machinery to the Worker is real complexity for no clear win over REST.
- The existing MCP tools are *reference-data lookup*, not *pipeline triggers* — new tools would have to be added regardless of transport.
- Security model shift: the MCP server is `127.0.0.1`-bound today. Public exposure needs harder auth + rate limiting.

### D. Webhook callback (additive to A)

`bp-assistant` POSTs to a `bible-editor` endpoint when a pipeline completes, reversing the polling direction.

**Pros**
- Avoids polling cost.
- Near-instant UI update on completion.

**Cons**
- `bible-editor` needs a public, authenticated webhook endpoint.
- Webhook delivery isn't guaranteed; still need polling as a fallback.
- Both sides must implement; pure additive cost on top of A.

---

## 7. Recommended approach

**Lead with A. Add D later if polling cost becomes annoying.** Rationale:

- **Smallest blast radius in `bp-assistant`.** One new endpoint pair + a checkpoint serializer. The `api-runner/` scaffold and `/health/pipelines` endpoint show the team is already partway here.
- **Reuses `repo-insert`.** Editor-triggered and Zulip-triggered pipelines have identical downstream flow → easy to reason about, easy to test.
- **The inbound-from-DCS path pays for itself.** `bible-editor` needs this regardless: initial book import is currently a one-shot script, re-baselining a book is impossible mid-session, external edits to Door43 are invisible to the editor. Building it once for AI integration gives us all of those for free.
- **"Data mesh" framing.** `bp-assistant` owns pipeline outputs and publishes them to Door43. `bible-editor` owns user edits and pulls from Door43 when invited. Each side has a clear data product and a clear contract.

What this implies, concretely:

**`bp-assistant` adds (we'll propose specifics in a follow-up):**
- `POST /api/pipeline/start` — body `{ pipelineType, book, chapter, options? }`, returns `{ jobId, scope, status: "running" }`.
- `GET /api/pipeline/:jobId` — returns `{ status, scope, stage?, startedAt, completedAt?, repoRefs?, error? }`.
- A serializer mapping the existing checkpoint records into the response shape.
- Bearer-token auth via the existing `BT_API_TOKEN` (with per-user attribution carried through the request).

**`bible-editor` adds (historical checklist; these items have largely shipped):**
- A trigger UI in the chapter view (probably mirroring the tn-quick sparkles pattern but at chapter scope).
- A Worker proxy endpoint that wraps `bp-assistant`'s `/api/pipeline/start` (same shape as the existing `tnQuick.ts` proxy — keeps `BT_API_TOKEN` server-side).
- A status table in D1 (`pipeline_jobs`) so multi-tab + reload-survival works.
- A poller (or eventual webhook handler) that, on completion, kicks the inbound-import path.
- A new **inbound-from-DCS import** path: given `(book, chapter, repoRef)`, fetch USFM/TSV from DCS, transform to row shapes, write to D1 with a clear conflict-resolution policy (see open questions).
- A surface in the UI for "AI pipeline in progress for chapter X" + "AI output ready for review for chapter X" states.

---

## 8. Open questions for `bp-assistant`

The proposal back should answer these:

1. **REST or MCP for pipeline triggers?** REST seems strictly simpler for our side. Does `bp-assistant`'s roadmap have a reason to prefer MCP we haven't seen?
2. **Concurrency policy.** One running pipeline per user? Per book? Globally? `bible-editor` needs to know what to reject vs queue. The deployment-locking workflow suggests there's already a token-budget rationale here.
3. **Status granularity.** Just `running | done | failed | paused`, or per-stage progress for the multi-wave `makeBP`? Per-stage is nicer UX but more contract surface.
4. **Where does output land?** `repo-insert` — does it commit directly to `master`, or open a PR? `bible-editor`'s inbound-import needs to know which ref to pull from. If PR, do we want to pull from the PR branch (preview before merge) or wait for merge?
5. **Provenance tagging.** Can `repo-insert` mark AI-authored commits in a machine-detectable way (commit trailer, author email, branch naming)? `bible-editor` could then tag those rows as "AI-generated" in `edit_log` and surface that in the UI.
6. **Auth model for editor-triggered runs.** The user is signed in to `bible-editor` via DCS OAuth. Should the trigger request carry their DCS identity through to `bp-assistant` (for attribution / rate-limiting per user), or is a shared service token enough?
7. **Cancellation.** Is mid-run cancellation supported? Useful if a translator changes their mind 5 minutes in.
8. **Idempotency.** If the user double-clicks the trigger, what happens? Do we want client-supplied idempotency keys?

And one open question **back to us** (the bp-assistant Claude should help us decide):

9. **Conflict resolution on inbound.** When AI output lands and the user has been editing the same chapter, options are:
   - (a) overwrite + toast notification, undo-able from `edit_log`,
   - (b) stage as a proposal in a review UI (user accepts/rejects per verse / per note),
   - (c) 3-way merge between AI output, pre-AI state, and user edits.

   (b) is the safest UX but the most work. (a) is the smallest build. What fits the actual workflow translators have when running these pipelines?

---

## 9. Reference: files cited above

**This side (`bible-editor`):**
- [api/migrations/0001_init.sql](../api/migrations/0001_init.sql) — D1 schema
- [api/src/types.ts](../api/src/types.ts) — row shapes
- [api/src/tnQuick.ts](../api/src/tnQuick.ts) — existing AI proxy
- [api/src/exportWorkflow.ts](../api/src/exportWorkflow.ts) — nightly DCS export
- [api/src/auth.ts](../api/src/auth.ts) — DCS OAuth
- [web/src/sync/outbox.ts](../web/src/sync/outbox.ts) — outbox sync
- [web/src/components/NoteCard.tsx](../web/src/components/NoteCard.tsx) — tn-quick UI
- [web/src/lib/tnQuickRequest.ts](../web/src/lib/tnQuickRequest.ts) — request assembly
- [scripts/import-book.mjs](../scripts/import-book.mjs) — one-shot initial book load

**Partner side (`bp-assistant`):**
- [src/router.js](https://github.com/unfoldingWord/bp-assistant/blob/main/src/router.js) — Zulip command routing
- [src/pipeline-runner.js](https://github.com/unfoldingWord/bp-assistant/blob/main/src/pipeline-runner.js), [generate-pipeline.js](https://github.com/unfoldingWord/bp-assistant/blob/main/src/generate-pipeline.js), [note-pipeline.js](https://github.com/unfoldingWord/bp-assistant/blob/main/src/note-pipeline.js), [notes-pipeline.js](https://github.com/unfoldingWord/bp-assistant/blob/main/src/notes-pipeline.js), [tqs-pipeline.js](https://github.com/unfoldingWord/bp-assistant/blob/main/src/tqs-pipeline.js) — pipeline kinds
- [src/pipeline-checkpoints.js](https://github.com/unfoldingWord/bp-assistant/blob/main/src/pipeline-checkpoints.js) — checkpoint store
- [src/mcp-server.js](https://github.com/unfoldingWord/bp-assistant/blob/main/src/mcp-server.js) — MCP server
- [src/api/tn-quick.js](https://github.com/unfoldingWord/bp-assistant/blob/main/src/api/tn-quick.js) — existing HTTP endpoint precedent
- [src/api-runner/](https://github.com/unfoldingWord/bp-assistant/tree/main/src/api-runner) — programmatic invocation scaffold
- [src/door43-push.js](https://github.com/unfoldingWord/bp-assistant/blob/main/src/door43-push.js), [repo-verify.js](https://github.com/unfoldingWord/bp-assistant/blob/main/src/repo-verify.js) — Door43 push + verification

**Skills repo (`bp-assistant-skills`):**
- [`.claude/skills/`](https://github.com/unfoldingWord/bp-assistant-skills/tree/main/.claude/skills) — `ULT-gen`, `UST-gen`, `tn-writer`, `tq-writer`, `ULT-alignment`, `UST-alignment`, `parallel-batch`, `makeBP`, `repo-insert`, `repo-verify`, `tn-quality-check`, `editor-compare`, `gemini-review`, and others.
