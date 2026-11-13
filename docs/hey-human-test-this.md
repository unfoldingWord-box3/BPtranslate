# Hey Human, Test This

Living checklist of things that need eyes-on verification — UI behaviors, live pipeline runs, anything an autonomous session can compile + reason about but can't actually exercise. Check items as you verify them; add notes under an item if something looks off and the next session will pick it up.

## How to use this doc

- **Open items** sit in "Pending verification." Check the box once you've confirmed the behavior.
- **Failures** go under their item as a sub-bullet — what you saw vs what was expected. The next session triages.
- **Done items** can be moved to "Verified" with the date + PR reference, or just left checked. Either is fine.
- **New items**: when you ship a PR that changes user-facing behavior or anything that needs a live pipeline run, add a checklist entry here as part of the PR.

---

## Pending verification

> Since #470 the AI menu no longer offers "Generate ULT + UST", "Write translation notes" or "Write translation questions" (they were switched off in #551, and their server code was removed in #726). Items below that start one of those runs, or the "Generate everything" chain, can't be exercised any more.

### Phase 2d — PR #14 (asymmetric alignment, AI chip, stage bar, cron polling)

The four items below shipped on 2026-05-13. Type-checks pass and the logic was reasoned through, but none of them have been exercised against a live `uw-bt-bot.fly.dev` run yet. The first live verification is the highest-risk path.

#### Asymmetric ULT/UST alignment

Removed with the "Generate ULT + UST" action in #470: the AI menu no longer offers it, so these runs can't be started.

#### AI provenance chip

- [ ] **Chip shows after a pipeline run.** Trigger any `tqs` or `notes` run on an untouched chapter. After completion, navigate to a TN or TQ that the AI wrote. Notes should carry a small outlined "AI" chip next to the 4-char id. Questions should show a sparkle icon next to the Ref input.
- [ ] **Chip clears after a human edit.** Edit a TN's quote or note field; save (blur or navigate away). Reload the chapter. The chip is gone on that row.
- [ ] **Chip persists across reloads when no human edit happened.** Reload the page without editing. Chip is still there on all AI-authored rows.
- [ ] **Chip clears after a Keep action.** During the run (locked chapter), click Keep on a TN. After the run completes and you reload, the chip should NOT show on that row — Keep counts as a human action.
- [ ] **No chip on rows that pre-date the AI run.** TNs the user created manually before the AI run shouldn't carry the chip (they're absent from the AI's new TN set; the delete sweep removes them only if `updated_by IS NULL`).

#### Per-stage progress bar

- [ ] **Generate run shows the 3-stage stepper.** Trigger a `generate` run. Open the PipelineStatusBar's expanded panel (click the pill). Three dots labeled Draft / Align / Push appear under the job. Early in the run, Draft is filled blue (current); Align + Push are outlined.
- [ ] **Stepper advances as the run progresses.** Mid-run (~30 min in), Draft should be filled green and Align should be filled blue. Late, Align green + Push blue. (You may need to wait between checks.)
- [ ] **Done state fills everything green.** When the run completes, all three dots are green.
- [ ] **Notes run shows tn-writer / parallel-batch / repo-insert.** Trigger a `notes` run; the panel shows Draft → Batch → Push.
- [ ] **Tqs run shows the 2-stage version.** Trigger a `tqs` run; the panel shows Draft → Push.
- [ ] **Unrecognized skill falls back gracefully.** If the bot reports a `current.skill` that isn't in our STAGES list, the stage bar stays dim (no dot highlighted) and the textual status line includes the raw skill name. (Hard to force on purpose — note any natural occurrence.)

#### Worker-side cron polling

- [ ] **Closed-tab `done` transition auto-applies within 5 minutes.** Trigger a `tqs` run. Once the bot starts (state=`running`), close the browser. Wait until you'd expect the bot to be done (poll bp-assistant directly or check Cloudflare logs). After completion, wait ~5 minutes more, then open the editor again. The chapter should already have the AI's TQs applied + edit_log rows with `source='ai_pipeline'`. **This is the highest-value verification — the whole point of Phase 2d.**
- [ ] **Cron tail shows the poller running.** With `wrangler tail` connected, watch for scheduled-handler invocations every 5 minutes. They should print quickly when no non-terminal jobs exist; spend longer when polling each non-terminal job.
- [ ] **Cron skips when there's nothing to poll.** With no running pipelines, the scheduled handler should return in <1s. Confirm via `wrangler tail` that we don't see upstream-fetch errors when the table is empty.

### Phase 3 — PR #18 (cron sentinel, focus event, parent-child link, conflict dialog, chapter macro)

Shipped 2026-05-14 as five small commits. Type-checks pass and the macro chain was reasoned through, but live verification is open. The chapter macro is the highest-risk path — a single live run exercises the full chain.

#### Cron auto-fail sentinel

- [ ] **Stuck row flips to failed.** Manually insert a wedged row:
  ```sh
  wrangler d1 execute bptranslate_dev --local --command \
    "INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, created_at, updated_at) VALUES ('stuck-test-1', 1, 'tqs', 'ZEC', 9, 9, 'bible-editor/1/stuck-test', 'running', unixepoch() - 86400 * 3, unixepoch() - 86400 * 3)"
  ```
  Wait for the next 5-minute cron tick (or invoke the scheduled handler manually via `wrangler dev --test-scheduled` + `curl localhost:8787/__scheduled`). Re-query — the row should now be `state='failed'`, `error_kind='interrupted'`, `error_message='auto-failed: no progress for 48h'`.
- [ ] **Healthy long runs untouched.** With a real ~3-hour generate active (within the 48h window), confirm the cron tick leaves it `running`.

#### `already_running` UX (Phase 3.4)

- [ ] **Re-POSTing the same scope opens the status panel.** Start a `tqs` run for ZEC 8 → wait for it to be `running`. Open a SECOND tab to the same `#/ZEC/8` URL (same browser → same sessionKey). Click AI pipelines → Write translation questions → Start. Expect: NO toast about "Started" or "Already running"; the status-bar pill auto-opens to show the running job. No second pipeline_jobs row appears.
- [ ] **Different browser still toasts.** Same scenario but from a different browser (different sessionKey) — should go through the 409 conflict path (see below), NOT the focus path.

#### Parent-child follow-up link (Phase 3.5)

- [ ] **Single-pipeline runs show no chain line.** A plain `tqs` run with no follow-up shows no Step-of-N line in the panel. (Negative check — verifies we're reading the column correctly, not always rendering.)

#### Concurrency UX (Phase 3.1, minimum viable)

- [ ] **Cross-user 409 opens an enriched dialog.** Simulate translator A by inserting a `pipeline_jobs` row with `user_id` matching a user other than your dev session. Try to start the same `(pipelineType, book, chapter)` from your session. Expect a dialog (not a toast) showing: pipelineType, scope, state, current_skill, "started by &lt;username&gt;", and "X min ago". Click Close — dialog dismisses, no state changes.
- [ ] **Conflict body falls through when the conflicting job isn't in our D1.** Manually trigger upstream via Zulip (without going through the editor) so the bp-assistant side has a running job that's NOT in our `pipeline_jobs`. Then attempt the same scope from the editor. Worker should fail to find the existing row and pass the bare 409 through → bare toast surfaces. (Edge case; only verify if convenient.)

#### Chapter macro (Phase 3.3) — **highest-risk path**

- [ ] **Macro creates first row + stashes the chain.** Pick an untouched chapter (ZEC 11 or later — avoid ZEC 3, 7, 8 that other tests use). Click AI pipelines → Generate everything → Start. Immediately:
  ```sh
  wrangler d1 execute bptranslate_dev --local --command \
    "SELECT job_id, pipeline_type, follow_up_chain, follow_up_job_id FROM pipeline_jobs WHERE book='ZEC' AND start_chapter=<N> ORDER BY created_at DESC LIMIT 5"
  ```
  Expect: ONE row, `pipeline_type='generate'`, `follow_up_chain='[{"pipelineType":"notes"},{"pipelineType":"tqs"}]'`, `follow_up_job_id=NULL`.
- [ ] **Step 2 (notes) fires on the generate's done-transition.** When the generate row transitions to `state='done'` (panel pill green), re-run the query. Expect: TWO rows. Generate's `follow_up_job_id` now points at row 2. Row 2 is `pipeline_type='notes'`, `state='running'`, `follow_up_chain='[{"pipelineType":"tqs"}]'` (only tqs left), `session_key` ends in `/chain1`.
- [ ] **Step 3 (tqs) fires on the notes' done-transition.** When the notes row transitions to `state='done'`, re-query. Expect: THREE rows. Notes' `follow_up_job_id` points at row 3. Row 3 is `pipeline_type='tqs'`, `state='running'`, `follow_up_chain=NULL` (terminal), `session_key` ends in `/chain2`.
- [ ] **Chapter lock holds across all three steps.** While ANY of the three runs are active, the chapter banner is visible and TN cards are read-only. There's a brief gap (≤5 min — the cron tick interval) between one step's done and the next step's running where the lock could release; note if any translator edits land during that window.
- [ ] **Done state shows AI output applied to chapter.** When all three complete, the chapter has new ULT/UST verses (with alignment), AI-authored TNs, and AI-authored TQs. `edit_log` shows three batches of `source='ai_pipeline'` (one per step).
- [ ] **Re-triggering the macro after completion is safe.** If you click "Generate everything" again on the same chapter post-completion, the upstream returns `already_running` for `pipeline_type='generate'` (the original done row), so we just open the status panel via the focus event. No new chain fires. (May need to verify the upstream semantics — depends on whether bp-assistant treats done jobs as "still occupying" the (sessionKey, scope) bucket.)

### Phase 2c — PR #12 (lock + auto-apply + TN keep marks)

Originally shipped 2026-05-13; sanity-check that PR #14's refactor of `pollPipelineJob` didn't regress anything.

- [ ] **Chapter lock still 409s row edits.** During any pipeline run, attempt `curl -X PATCH ...` against a TN's note field. Response is `{"error":"chapter_locked", "jobId":"...", ...}` with status 409.
- [ ] **Keep checkbox still works.** During the run, on an unkept TN card, click Keep. Card flips to editable, "Kept" chip appears, no error in the console.
- [ ] **Auto-apply runs once per `done` transition.** After a completed run, check `SELECT count(*), source FROM edit_log WHERE row_key LIKE 'ZEC/<N>%' GROUP BY source` — only one batch of `source='ai_pipeline'` rows, not duplicates.

---

## Verified

_Move items here once they've been confirmed end-to-end. Date + PR ref helps the next person._

- ✅ **Phase 1 — pipeline trigger + poll + status surface** (2026-05-?? · #11). Verified live with a `tqs` run for ZEC 3 against `uw-bt-bot.fly.dev`. Output landed on Door43; editor polling surfaced state transitions correctly.
- ✅ **Phase 2a — parser smoke** (2026-05-?? · #11 follow-up). Parser test against `docs/samples/` produces 10 ULT verses, 49 TN rows, 9 TQ rows for ZEC 3. Run via `node --experimental-strip-types --no-warnings api/src/importParsers.test.mjs`.
